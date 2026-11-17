// A compact GraphQL v4 engine for POST /api/graphql: a lexer/parser for the document
// shapes gh and github-mcp-server send (operations, variables, aliases, inline fragments,
// input objects, enum lists, batching), a schema with the types the suite probes, field
// validation (an unknown field is a 200 with an `errors` array naming it), and resolvers
// over the same store the REST and MCP surfaces use.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthed, sendJson } from './http-util.ts';
import {
  ForgeError,
  VIEWER,
  addComment,
  branchTip,
  createIssue,
  createPull,
  getRepo,
  mergePull,
  pullFiles,
  pullMergeable,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// --------------------------------------------------------------------------- lexer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
  value: string;
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      const text = match?.[0] ?? ch;
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      const text = match?.[0] ?? ch;
      tokens.push({ kind: 'name', value: text });
      i += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Record<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private skip(value: string): boolean {
    if (this.peek().value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: {}, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefaults: Record<string, ValueNode> = {};
        if (this.skip('(')) {
          while (!this.skip(')')) {
            this.expect('$');
            const varName = this.next().value;
            this.expect(':');
            this.parseType();
            if (this.skip('=')) variableDefaults[varName] = this.parseValue();
            if (this.peek().value === '@') this.parseDirectives();
          }
        }
        if (this.peek().value === '@') this.parseDirectives();
        operations.push({ type, name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const onToken = this.next();
        if (onToken.value !== 'on') throw new Error('expected "on" in fragment definition');
        const typeCondition = this.next().value;
        if (this.peek().value === '@') this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    this.skip('!');
  }

  private parseDirectives(): void {
    while (this.skip('@')) {
      this.next();
      if (this.skip('(')) {
        while (!this.skip(')')) {
          this.next();
          this.expect(':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.skip('}')) {
      if (this.peek().value === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          if (this.peek().value === '@') this.parseDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next().value;
          if (this.peek().value === '@') this.parseDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      let name = this.next().value;
      let alias: string | null = null;
      if (this.skip(':')) {
        alias = name;
        name = this.next().value;
      }
      const args: Record<string, ValueNode> = {};
      if (this.skip('(')) {
        while (!this.skip(')')) {
          const argName = this.next().value;
          this.expect(':');
          args[argName] = this.parseValue();
        }
      }
      if (this.peek().value === '@') this.parseDirectives();
      const selectionSet = this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int' || token.kind === 'float') return { kind: 'number', value: Number(token.value) };
    if (token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skip(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!this.skip('}')) {
        const key = this.next().value;
        this.expect(':');
        fields[key] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

function valueFromNode(node: ValueNode, variables: Record<string, unknown>, defaults: Record<string, ValueNode>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in variables) return variables[node.name];
      const fallback = defaults[node.name];
      return fallback === undefined ? undefined : valueFromNode(fallback, variables, defaults);
    }
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueFromNode(item, variables, defaults));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueFromNode(value, variables, defaults);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema (validation + introspection)

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  fields?: Record<string, string>;
  enumValues?: string[];
}

const objectType = (fields: Record<string, string>): TypeDef => ({ kind: 'OBJECT', fields });
const enumType = (values: string[]): TypeDef => ({ kind: 'ENUM', enumValues: values });

export const SCHEMA: Record<string, TypeDef> = {
  Query: objectType({
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
    __schema: '__Schema',
  }),
  Mutation: objectType({
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  }),
  User: objectType({ id: 'ID', login: 'String', name: 'String', email: 'String', url: 'String' }),
  Repository: objectType({
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    description: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean',
    hasPullRequestsEnabled: 'Boolean',
    isPrivate: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequest: 'PullRequest',
    pullRequests: 'PullRequestConnection',
    url: 'String',
    createdAt: 'String',
    updatedAt: 'String',
  }),
  Ref: objectType({ name: 'String', prefix: 'String', target: 'RefTarget' }),
  RefTarget: objectType({ oid: 'String' }),
  Issue: objectType({
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'IssueState',
    author: 'User',
    repository: 'Repository',
    url: 'String',
    createdAt: 'String',
    updatedAt: 'String',
  }),
  PullRequest: objectType({
    id: 'ID',
    number: 'Int',
    title: 'String',
    body: 'String',
    state: 'PullRequestState',
    merged: 'Boolean',
    mergeable: 'MergeableState',
    headRefName: 'String',
    baseRefName: 'String',
    author: 'User',
    repository: 'Repository',
    files: 'PullRequestChangedFileConnection',
    url: 'String',
    createdAt: 'String',
    updatedAt: 'String',
  }),
  IssueConnection: objectType({ nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' }),
  IssueEdge: objectType({ node: 'Issue', cursor: 'String' }),
  PullRequestConnection: objectType({ nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' }),
  PullRequestEdge: objectType({ node: 'PullRequest', cursor: 'String' }),
  PageInfo: objectType({ hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' }),
  PullRequestChangedFileConnection: objectType({ nodes: '[PullRequestChangedFile]', totalCount: 'Int' }),
  PullRequestChangedFile: objectType({ path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' }),
  Comment: objectType({ id: 'ID', body: 'String', author: 'User', createdAt: 'String' }),
  CreateIssuePayload: objectType({ issue: 'Issue', clientMutationId: 'String' }),
  CloseIssuePayload: objectType({ issue: 'Issue', clientMutationId: 'String' }),
  CreatePullRequestPayload: objectType({ pullRequest: 'PullRequest', clientMutationId: 'String' }),
  MergePullRequestPayload: objectType({ pullRequest: 'PullRequest', clientMutationId: 'String' }),
  AddCommentPayload: objectType({ commentEdge: 'CommentEdge', subject: 'Node', clientMutationId: 'String' }),
  CommentEdge: objectType({ node: 'Comment', cursor: 'String' }),
  Node: { kind: 'INTERFACE', fields: { id: 'ID' } },
  __Type: objectType({ name: 'String', kind: 'String', description: 'String', fields: '[__Field]', enumValues: '[__EnumValue]', possibleTypes: '[__Type]', inputFields: '[__InputValue]', ofType: '__Type' }),
  __Field: objectType({ name: 'String', description: 'String', type: '__Type', args: '[__InputValue]' }),
  __EnumValue: objectType({ name: 'String', description: 'String' }),
  __InputValue: objectType({ name: 'String', type: '__Type', defaultValue: 'String' }),
  __Schema: objectType({ types: '[__Type]', queryType: '__Type', mutationType: '__Type' }),
  IssueState: enumType(['OPEN', 'CLOSED']),
  PullRequestState: enumType(['OPEN', 'CLOSED', 'MERGED']),
  MergeableState: enumType(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
  RepositoryPermission: enumType(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ']),
  OrderDirection: enumType(['ASC', 'DESC']),
  IssueOrderField: enumType(['CREATED_AT', 'UPDATED_AT', 'COMMENTS']),
  PullRequestMergeMethod: enumType(['MERGE', 'SQUASH', 'REBASE']),
  SearchType: enumType(['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION']),
};

/** The types a fragment on `typeName` may apply to (itself, plus implementors for Node). */
function fragmentApplies(condition: string, typeName: string): boolean {
  if (condition === typeName) return true;
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User', 'Comment'].includes(typeName);
  return false;
}

function validateSelections(typeName: string, selections: SelectionNode[], doc: DocumentNode, errors: string[]): void {
  const def = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      validateSelections(selection.typeCondition, selection.selectionSet, doc, errors);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(fragment.typeCondition, fragment.selectionSet, doc, errors);
      else errors.push(`Unknown fragment "${selection.name}".`);
      continue;
    }
    if (selection.name === '__typename') continue;
    if (def === undefined || def.fields === undefined || !(selection.name in def.fields)) {
      errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
      continue;
    }
    if (selection.selectionSet !== null) {
      const target = (def.fields[selection.name] as string).replace(/[[\]!]/g, '');
      if (SCHEMA[target]?.kind === 'OBJECT' || SCHEMA[target]?.kind === 'INTERFACE') {
        validateSelections(target, selection.selectionSet, doc, errors);
      }
    }
  }
}

// --------------------------------------------------------------------------- global ids

function gid(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGid(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const split = decoded.indexOf(':');
    if (split === -1) return null;
    return { type: decoded.slice(0, split), key: decoded.slice(split + 1) };
  } catch {
    return null;
  }
}

function repoByDatabaseId(databaseId: number): RepoRec | null {
  for (const repo of repoIndex.values()) if (repo.databaseId === databaseId) return repo;
  return null;
}

// A tiny index by "owner/name" is unnecessary: getRepo covers lookups by name, and the
// database-id scan walks the same map the store keeps. To avoid a second source of truth
// this module reaches the store through a callback the app registers at boot.
import { listRepos } from './store.ts';
const repoIndex = {
  values: (): RepoRec[] => listRepos(VIEWER.login),
};

// --------------------------------------------------------------------------- wrapped values

interface Wrapped {
  __typename: string;
  [key: string]: unknown;
}

const wrapUser = (login: string): Wrapped => ({ __typename: 'User', login });
const wrapRepo = (repo: RepoRec): Wrapped => ({ __typename: 'Repository', repo });
const wrapIssue = (repo: RepoRec, issue: IssueRec): Wrapped => ({ __typename: 'Issue', repo, issue });
const wrapPull = (repo: RepoRec, pull: PullRec): Wrapped => ({ __typename: 'PullRequest', repo, pull });

function cursorOf(key: number): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64');
}

function keyFromCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const value = Number.parseInt(decoded.slice('cursor:'.length), 10);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

interface ConnectionArgs {
  first?: number;
  after?: string | null;
}

function buildConnection<T extends Wrapped>(typeName: string, edgeType: string, items: T[], keyOf: (item: T) => number, args: ConnectionArgs): Wrapped {
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const key = keyFromCursor(args.after);
    if (key !== null) {
      const index = items.findIndex((item) => keyOf(item) === key);
      if (index !== -1) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : items.length;
  const nodes = items.slice(start, start + first);
  const hasNextPage = start + nodes.length < items.length;
  return {
    __typename: typeName,
    nodes,
    edges: nodes.map((node) => ({ __typename: edgeType, node, cursor: cursorOf(keyOf(node)) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorOf(keyOf(nodes[0] as T)) : null,
      endCursor: nodes.length > 0 ? cursorOf(keyOf(nodes[nodes.length - 1] as T)) : (typeof args.after === 'string' ? args.after : null),
    },
    totalCount: items.length,
  };
}

// --------------------------------------------------------------------------- resolvers

interface Ctx {
  variables: Record<string, unknown>;
  defaults: Record<string, ValueNode>;
  doc: DocumentNode;
  errors: { message: string }[];
}

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) out[name] = valueFromNode(node, ctx.variables, ctx.defaults);
  return out;
}

function resolveField(typeName: string, source: Wrapped, field: FieldNode, ctx: Ctx): unknown {
  const args = argsOf(field, ctx);
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return wrapUser(VIEWER.login);
      if (field.name === 'repository') {
        const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : wrapRepo(repo);
      }
      if (field.name === 'node') return resolveNode(String(args.id ?? ''));
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        return SCHEMA[name] === undefined ? null : { __typename: '__Type', name };
      }
      if (field.name === '__schema') return { __typename: '__Schema' };
      return null;
    }
    case 'Mutation': {
      return resolveMutation(field.name, args);
    }
    case 'User': {
      const login = source.login as string;
      if (field.name === 'id') return gid('User', login);
      if (field.name === 'login') return login;
      if (field.name === 'name') return login === VIEWER.login ? VIEWER.name : login;
      if (field.name === 'email') return login === VIEWER.login ? VIEWER.email : null;
      if (field.name === 'url') return `https://forge.invalid/${login}`;
      return null;
    }
    case 'Repository': {
      const repo = source.repo as RepoRec;
      switch (field.name) {
        case 'id':
          return gid('Repository', String(repo.databaseId));
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'owner':
          return wrapUser(repo.owner);
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === null ? null : { __typename: 'Ref', repo, name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return repo.owner === VIEWER.login ? 'ADMIN' : 'READ';
        case 'hasIssuesEnabled':
          return true;
        case 'hasPullRequestsEnabled':
          return true;
        case 'isPrivate':
          return repo.isPrivate;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : wrapIssue(repo, issue);
        }
        case 'issues': {
          let issues = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
          const descending = orderBy?.direction === 'DESC';
          issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
          return buildConnection('IssueConnection', 'IssueEdge', issues.map((issue) => wrapIssue(repo, issue)), (item) => (item.issue as IssueRec).number, args as ConnectionArgs);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : wrapPull(repo, pull);
        }
        case 'pullRequests': {
          let pulls = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
          pulls = pulls.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
            return states.includes(state) || (states.includes('CLOSED') && state === 'MERGED');
          });
          pulls.sort((a, b) => a.number - b.number);
          return buildConnection('PullRequestConnection', 'PullRequestEdge', pulls.map((pull) => wrapPull(repo, pull)), (item) => (item.pull as PullRec).number, args as ConnectionArgs);
        }
        case 'url':
          return `https://forge.invalid/${repo.owner}/${repo.name}`;
        case 'createdAt':
        case 'updatedAt':
          return new Date(1739175597000 + repo.createdSeq * 1000).toISOString();
        default:
          return null;
      }
    }
    case 'Ref': {
      const repo = source.repo as RepoRec;
      if (field.name === 'name') return source.name;
      if (field.name === 'prefix') return 'refs/heads/';
      if (field.name === 'target') {
        const tip = branchTip(repo, source.name as string);
        return tip === null ? null : { __typename: 'RefTarget', oid: tip };
      }
      return null;
    }
    case 'RefTarget':
      return field.name === 'oid' ? source.oid : null;
    case 'Issue': {
      const repo = source.repo as RepoRec;
      const issue = source.issue as IssueRec;
      switch (field.name) {
        case 'id':
          return gid('Issue', `${repo.databaseId}:${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state.toUpperCase();
        case 'author':
          return wrapUser(VIEWER.login);
        case 'repository':
          return wrapRepo(repo);
        case 'url':
          return `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt':
        case 'updatedAt':
          return new Date(1739175597000 + issue.id).toISOString();
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = source.repo as RepoRec;
      const pull = source.pull as PullRec;
      switch (field.name) {
        case 'id':
          return gid('PullRequest', `${repo.databaseId}:${pull.number}`);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergeable':
          if (pull.state !== 'open') return 'UNKNOWN';
          return pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'author':
          return wrapUser(VIEWER.login);
        case 'repository':
          return wrapRepo(repo);
        case 'files': {
          const first = typeof args.first === 'number' ? Math.floor(args.first) : 100;
          const files = pullFiles(repo, pull);
          return {
            __typename: 'PullRequestChangedFileConnection',
            nodes: files.slice(0, first).map((file) => ({
              __typename: 'PullRequestChangedFile',
              path: file.filename,
              additions: file.additions,
              deletions: file.deletions,
              changeType: file.status.toUpperCase(),
            })),
            totalCount: files.length,
          };
        }
        case 'url':
          return `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'createdAt':
        case 'updatedAt':
          return new Date(1739175597000 + pull.id).toISOString();
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
      return source[field.name] ?? null;
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'CommentEdge':
      return source[field.name] ?? null;
    case 'PageInfo':
      return source[field.name] ?? null;
    case 'PullRequestChangedFileConnection':
      return source[field.name] ?? null;
    case 'PullRequestChangedFile':
      return source[field.name] ?? null;
    case 'Comment': {
      if (field.name === 'id') return source.id;
      if (field.name === 'body') return source.body;
      if (field.name === 'author') return wrapUser(VIEWER.login);
      if (field.name === 'createdAt') return new Date(1739175597000).toISOString();
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return source[field.name] ?? null;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return source[field.name] ?? null;
    case 'AddCommentPayload':
      return source[field.name] ?? null;
    case '__Type': {
      const name = source.name as string;
      const def = SCHEMA[name];
      if (def === undefined) return null;
      switch (field.name) {
        case 'name':
          return name;
        case 'kind':
          return def.kind;
        case 'description':
          return null;
        case 'fields':
          return def.fields === undefined ? null : Object.keys(def.fields).map((fieldName) => ({ __typename: '__Field', name: fieldName, parentType: name }));
        case 'enumValues':
          return def.enumValues === undefined ? null : def.enumValues.map((value) => ({ __typename: '__EnumValue', name: value }));
        case 'possibleTypes':
          return name === 'Node' ? ['Repository', 'Issue', 'PullRequest', 'User', 'Comment'].map((typeName) => ({ __typename: '__Type', name: typeName })) : null;
        case 'inputFields':
          return null;
        case 'ofType':
          return null;
        default:
          return null;
      }
    }
    case '__Field': {
      if (field.name === 'name') return source.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') {
        const parent = SCHEMA[source.parentType as string];
        const typeName = (parent?.fields?.[source.name as string] ?? 'String').replace(/[[\]!]/g, '');
        return { __typename: '__Type', name: typeName };
      }
      if (field.name === 'args') return [];
      return null;
    }
    case '__EnumValue':
      return field.name === 'name' ? source.name : null;
    case '__InputValue':
      return field.name === 'name' ? source.name : null;
    case '__Schema': {
      if (field.name === 'queryType') return { __typename: '__Type', name: 'Query' };
      if (field.name === 'mutationType') return { __typename: '__Type', name: 'Mutation' };
      if (field.name === 'types') return Object.keys(SCHEMA).map((name) => ({ __typename: '__Type', name }));
      return null;
    }
    default:
      return (source as Record<string, unknown>)[field.name] ?? null;
  }
}

function resolveNode(id: string): Wrapped | null {
  const parsed = parseGid(id);
  if (parsed === null) return null;
  if (parsed.type === 'Repository') {
    const repo = repoByDatabaseId(Number(parsed.key));
    return repo === null ? null : wrapRepo(repo);
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [databaseId, number] = parsed.key.split(':').map((part) => Number(part));
    const repo = repoByDatabaseId(databaseId as number);
    if (repo === null) return null;
    if (parsed.type === 'Issue') {
      const issue = repo.issues.get(number as number);
      return issue === undefined ? null : wrapIssue(repo, issue);
    }
    const pull = repo.pulls.get(number as number);
    return pull === undefined ? null : wrapPull(repo, pull);
  }
  if (parsed.type === 'User') return wrapUser(parsed.key);
  return null;
}

function repoFromGid(id: unknown): RepoRec {
  const parsed = typeof id === 'string' ? parseGid(id) : null;
  if (parsed === null || parsed.type !== 'Repository') throw new Error(`invalid repository id ${String(id)}`);
  const repo = repoByDatabaseId(Number(parsed.key));
  if (repo === null) throw new Error(`repository ${String(id)} not found`);
  return repo;
}

function recordFromGid(id: unknown): { repo: RepoRec; record: IssueRec | PullRec } {
  const parsed = typeof id === 'string' ? parseGid(id) : null;
  if (parsed === null || (parsed.type !== 'Issue' && parsed.type !== 'PullRequest')) throw new Error(`invalid subject id ${String(id)}`);
  const [databaseId, number] = parsed.key.split(':').map((part) => Number(part));
  const repo = repoByDatabaseId(databaseId as number);
  if (repo === null) throw new Error('subject repository not found');
  const record = parsed.type === 'Issue' ? repo.issues.get(number as number) : repo.pulls.get(number as number);
  if (record === undefined) throw new Error('subject not found');
  return { repo, record };
}

function resolveMutation(name: string, args: Record<string, unknown>): Wrapped {
  const input = (args.input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'createIssue': {
        const repo = repoFromGid(input.repositoryId);
        const issue = createIssue(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
        });
        return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, issue), clientMutationId: input.clientMutationId ?? null };
      }
      case 'closeIssue': {
        const { repo, record } = recordFromGid(input.issueId);
        if (record.kind !== 'issue') throw new Error('subject is not an issue');
        record.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: wrapIssue(repo, record), clientMutationId: input.clientMutationId ?? null };
      }
      case 'createPullRequest': {
        const repo = repoFromGid(input.repositoryId);
        const pull = createPull(repo, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          head: typeof input.headRefName === 'string' ? input.headRefName : '',
          base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
        });
        return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pull), clientMutationId: input.clientMutationId ?? null };
      }
      case 'mergePullRequest': {
        const { repo, record } = recordFromGid(input.pullRequestId);
        if (record.kind !== 'pull') throw new Error('subject is not a pull request');
        const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
        const method = methodRaw === 'merge' ? 'merge' : methodRaw === 'rebase' ? 'rebase' : 'squash';
        mergePull(repo, record, method);
        return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(repo, record), clientMutationId: input.clientMutationId ?? null };
      }
      case 'addComment': {
        const { repo, record } = recordFromGid(input.subjectId);
        const body = typeof input.body === 'string' ? input.body : '';
        const comment = addComment(record, body);
        const node: Wrapped = {
          __typename: 'Comment',
          id: gid('Comment', `${repo.databaseId}:${record.number}:${comment.id}`),
          body: comment.body,
        };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'CommentEdge', node, cursor: cursorOf(comment.id) },
          subject: record.kind === 'issue' ? wrapIssue(repo, record) : wrapPull(repo, record),
          clientMutationId: input.clientMutationId ?? null,
        };
      }
      default:
        throw new Error(`unknown mutation ${name}`);
    }
  } catch (err) {
    if (err instanceof ForgeError) throw new Error(err.message);
    throw err;
  }
}

// --------------------------------------------------------------------------- executor

function executeSelectionSet(typeName: string, source: Wrapped, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (fragmentApplies(selection.typeCondition, typeName)) {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment !== undefined && fragmentApplies(fragment.typeCondition, typeName)) {
        Object.assign(out, executeSelectionSet(typeName, source, fragment.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(typeName, source, selection, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object') {
    const wrapped = value as Wrapped;
    if (typeof wrapped.__typename === 'string' && field.selectionSet !== null) {
      return executeSelectionSet(wrapped.__typename, wrapped, field.selectionSet, ctx);
    }
    return value;
  }
  return value;
}

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function executeOperation(doc: DocumentNode, operationName: string | null, variables: Record<string, unknown>, queryText: string): OperationResult {
  let operation: OperationNode | undefined;
  if (operationName !== null) operation = doc.operations.find((op) => op.name === operationName);
  else operation = doc.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation to execute' }] };
  void queryText;
  const validationErrors: string[] = [];
  validateSelections(operation.type === 'query' ? 'Query' : 'Mutation', operation.selectionSet, doc, validationErrors);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  const ctx: Ctx = { variables, defaults: operation.variableDefaults, doc, errors: [] };
  const rootType = operation.type === 'query' ? 'Query' : 'Mutation';
  const data = executeSelectionSet(rootType, { __typename: rootType }, operation.selectionSet, ctx);
  const result: OperationResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

// --------------------------------------------------------------------------- the HTTP handler

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'request body is not JSON' }] });
    return;
  }
  const runOne = (entry: unknown): OperationResult => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'operation is not an object' }] };
    }
    const operation = entry as Record<string, unknown>;
    const query = typeof operation.query === 'string' ? operation.query : '';
    const variables = (operation.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof operation.operationName === 'string' ? operation.operationName : null;
    try {
      const doc = new Parser(lex(query)).parseDocument();
      return executeOperation(doc, operationName, variables, query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
