// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking the modern
// 2026-07-28 dialect (server/discover, no handshake, no session) and answering the legacy
// initialize handshake as well. The six tools act on the same store as REST and GraphQL,
// and their results carry the same JSON shapes the REST surface returns.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthed, sendJson } from './http-util.ts';
import { ForgeError, VIEWER, createIssue, createPull, createRepo, getRepo, mergePull, type RepoRec } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const stringProp = (description: string): { type: string; description: string } => ({ type: 'string', description });

/** The tool list is a constant: two tools/list calls answer byte-identical lists. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the given owner (the token owner).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: stringProp('The repository owner login.'), repo: stringProp('The repository name.') },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('The issue state filter: open, closed or all.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        body: stringProp('The pull request body.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcError {
  code: number;
  message: string;
}

function resultBody(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errorBody(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function requireRepo(owner: unknown, repo: unknown): RepoRec {
  const found = getRepo(typeof owner === 'string' ? owner : '', typeof repo === 'string' ? repo : '');
  if (found === null) throw new Error(`repository ${String(owner)}/${String(repo)} not found`);
  return found;
}

/** Run one tool; returns a tool result, or throws RpcError-shaped {code, message}. */
function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw { code: -32602, message: `Unknown tool: ${name}` } as RpcError;
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw { code: -32602, message: `Missing required argument: ${required}` } as RpcError;
    }
  }
  try {
    switch (name) {
      case 'create_repo': {
        const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
        if (owner !== VIEWER.login) return toolFailure(`cannot create a repository for another owner: ${owner}`);
        const repo = createRepo(owner, String(args.name), {
          isPrivate: args.private === true,
          description: typeof args.description === 'string' ? args.description : '',
        });
        return toolSuccess(repoJson(repo));
      }
      case 'get_repo': {
        const repo = requireRepo(args.owner, args.repo);
        return toolSuccess(repoJson(repo));
      }
      case 'create_issue': {
        const repo = requireRepo(args.owner, args.repo);
        const issue = createIssue(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
        });
        return toolSuccess(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = requireRepo(args.owner, args.repo);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        issues.sort((a, b) => a.number - b.number);
        return toolSuccess(issues.map((issue) => issueJson(repo, issue)));
      }
      case 'create_pull_request': {
        const repo = requireRepo(args.owner, args.repo);
        const pull = createPull(repo, {
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          head: String(args.head),
          base: String(args.base),
        });
        return toolSuccess(pullJson(repo, pull));
      }
      case 'merge_pull_request': {
        const repo = requireRepo(args.owner, args.repo);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
        const pull = repo.pulls.get(number);
        if (pull === undefined) return toolFailure(`pull request #${String(args.pull_number)} not found`);
        mergePull(repo, pull, 'squash');
        return toolSuccess(pullJson(repo, pull));
      }
      default:
        throw { code: -32602, message: `Unknown tool: ${name}` } as RpcError;
    }
  } catch (err) {
    if (err instanceof ForgeError) return toolFailure(err.message);
    if (err instanceof Error) return toolFailure(err.message);
    throw err;
  }
}

function dispatch(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return callTool(name, args);
    }
    default:
      throw { code: -32601, message: `Method not found: ${method}` } as RpcError;
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, errorBody(null, { code: -32601, message: 'Method not allowed: POST only' }));
    return;
  }
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, errorBody(null, { code: -32700, message: 'Parse error' }));
    return;
  }
  if (Array.isArray(parsed)) {
    // Batch JSON-RPC is not part of the dialects the suite speaks; answer per entry anyway.
    const answers = parsed.map((entry) => handleOne(entry));
    sendJson(res, 200, answers.filter((answer) => answer !== null));
    return;
  }
  const answer = handleOne(parsed);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}

function handleOne(entry: unknown): Record<string, unknown> | null {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return errorBody(null, { code: -32600, message: 'Invalid request' });
  }
  const request = entry as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const hasId = 'id' in request;
  const id = request.id ?? null;
  const params = (request.params ?? {}) as Record<string, unknown>;
  try {
    const result = dispatch(method, params);
    if (!hasId) return null; // a notification: no answer
    return resultBody(id, result);
  } catch (err) {
    if (!hasId) return null;
    const rpcError = err as RpcError;
    if (typeof rpcError?.code === 'number') return errorBody(id, { code: rpcError.code, message: rpcError.message });
    return errorBody(id, { code: -32603, message: err instanceof Error ? err.message : 'Internal error' });
  }
}
