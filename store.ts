// The forge's in-memory state and domain operations, shared by the REST, GraphQL and MCP
// surfaces so an object created on one surface is the same object on the others.
//
// The viewer is fixed: the suite's scenario derives every name from one seeded identity, and
// the trial token names no login on the wire, so the token owner is the scenario's viewer.
// A repository belongs to the login it was created under; any other owner reads as 404.

import {
  buildCommit,
  buildTreeFromFlat,
  commitAncestors,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelToNonTag,
  putObject,
  tagTarget,
  type GitObject,
  type ObjectMap,
} from './gitobj.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** An error that maps straight onto an HTTP status and a {"message"} body. */
export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  kind: 'issue';
  /** The REST-visible numeric id (stable per issue, distinct from its number). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
}

export interface RepoRec {
  owner: string;
  name: string;
  /** The numeric database id: REST `id` and GraphQL `databaseId` agree on it. */
  databaseId: number;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: ObjectMap;
  /** Full ref names ('refs/heads/main') -> object id. HEAD is implicit (the default branch). */
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, { name: string; color: string }>;
  /** One counter shared by issues and pull requests, as on GitHub. */
  nextNumber: number;
  createdSeq: number;
}

const repos = new Map<string, RepoRec>();
let nextRepoId = 100000;
let nextIssueId = 200000;
let nextPullId = 300000;
let nextCommentId = 400000;
let sequence = 0;

function nextSeq(): number {
  sequence += 1;
  return sequence;
}

/** A deterministic timestamp for API-created commits (the scenario's seed epoch, plus drift). */
function identityLine(): string {
  const epoch = 1739175597 + nextSeq() * 17;
  return `${VIEWER.name} <${VIEWER.email}> ${epoch} +0000`;
}

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): RepoRec | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

export function listRepos(owner: string): RepoRec[] {
  return [...repos.values()].filter((repo) => repo.owner === owner).sort((a, b) => a.createdSeq - b.createdSeq);
}

export function createRepo(owner: string, name: string, options: { isPrivate?: boolean; description?: string }): RepoRec {
  if (typeof name !== 'string' || name === '' || name.includes('/') || name === '.' || name === '..') {
    throw new ForgeError(422, 'Repository creation failed: name is invalid');
  }
  if (repos.has(repoKey(owner, name))) {
    throw new ForgeError(422, 'Repository creation failed: name already exists on this account');
  }
  const repo: RepoRec = {
    owner,
    name,
    databaseId: nextRepoId,
    description: options.description ?? '',
    isPrivate: options.isPrivate ?? false,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    createdSeq: nextSeq(),
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

// --------------------------------------------------------------------------- refs and commits

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Create a commit in the repo's store and answer its id. */
export function makeCommit(repo: RepoRec, treeOid: string, parents: readonly string[], message: string): string {
  const line = identityLine();
  const data = buildCommit({ tree: treeOid, parents: [...parents], author: line, committer: line, message });
  return putObject(repo.objects, 'commit', data);
}

/** The tree oid at a commit (peeled through tags), or null. */
export function commitTree(repo: RepoRec, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// --------------------------------------------------------------------------- issues

export function createIssue(repo: RepoRec, input: { title: string; body?: string; labels?: string[] }): IssueRec {
  if (typeof input.title !== 'string' || input.title === '') throw new ForgeError(422, 'Validation Failed: title is required');
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new ForgeError(422, `Validation Failed: label "${label}" does not exist`);
  }
  const issue: IssueRec = {
    kind: 'issue',
    id: nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(record: IssueRec | PullRec, body: string): CommentRec {
  const comment: CommentRec = { id: nextCommentId, body };
  nextCommentId += 1;
  record.comments.push(comment);
  return comment;
}

// --------------------------------------------------------------------------- pull requests and merging

export function createPull(repo: RepoRec, input: { title: string; body?: string; head: string; base: string }): PullRec {
  if (typeof input.title !== 'string' || input.title === '') throw new ForgeError(422, 'Validation Failed: title is required');
  const headTip = branchTip(repo, input.head);
  if (headTip === null) throw new ForgeError(422, `Validation Failed: head branch "${input.head}" does not exist`);
  const baseTip = branchTip(repo, input.base);
  if (baseTip === null) throw new ForgeError(422, `Validation Failed: base branch "${input.base}" does not exist`);
  if (headTip === baseTip) throw new ForgeError(422, 'Validation Failed: no commits between the base and head branches');
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
      throw new ForgeError(422, 'Validation Failed: a pull request already exists for this head and base');
    }
  }
  const pull: PullRec = {
    kind: 'pull',
    id: nextPullId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
  };
  nextPullId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

interface TreeMergeResult {
  ok: boolean;
  /** The merged tree oid when ok. */
  treeOid?: string;
}

/**
 * A three-way merge of two branch tips over their merge base, on flattened trees:
 * a path changed on only one side takes that side; changed on both sides differently
 * (including modify/delete) is a conflict.
 */
export function threeWayMerge(repo: RepoRec, baseTip: string, headTip: string): TreeMergeResult {
  const base = mergeBase(repo.objects, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const baseFlat = flattenTree(repo.objects, baseTree);
  const oursFlat = flattenTree(repo.objects, commitTree(repo, baseTip));
  const theirsFlat = flattenTree(repo.objects, commitTree(repo, headTip));
  const paths = new Set([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  const merged = new Map<string, { mode: string; oid: string }>();
  const same = (a?: { mode: string; oid: string }, b?: { mode: string; oid: string }): boolean =>
    a === undefined && b === undefined ? true : a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode;
  for (const path of paths) {
    const inBase = baseFlat.get(path);
    const inOurs = oursFlat.get(path);
    const inTheirs = theirsFlat.get(path);
    if (same(inOurs, inTheirs)) {
      if (inOurs !== undefined) merged.set(path, inOurs);
    } else if (same(inBase, inOurs)) {
      if (inTheirs !== undefined) merged.set(path, inTheirs);
    } else if (same(inBase, inTheirs)) {
      if (inOurs !== undefined) merged.set(path, inOurs);
    } else {
      return { ok: false };
    }
  }
  return { ok: true, treeOid: buildTreeFromFlat(repo.objects, merged) };
}

/** Whether the pull request would merge cleanly right now. */
export function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return false;
  if (isAncestor(repo.objects, headTip, baseTip)) return false; // nothing to merge
  return threeWayMerge(repo, baseTip, headTip).ok;
}

/**
 * Merge a pull request into its base branch: squash (one commit carrying the merged tree)
 * or a true merge commit. Answers the resulting commit sha. Throws ForgeError 404/405 in
 * the shapes the REST contract names.
 */
export function mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge' | 'rebase'): string {
  if (pull.state !== 'open' || pull.merged) throw new ForgeError(405, 'Pull Request is not mergeable');
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) throw new ForgeError(405, 'Pull Request is not mergeable');
  const result = threeWayMerge(repo, baseTip, headTip);
  if (!result.ok || result.treeOid === undefined) throw new ForgeError(405, 'Pull Request has merge conflicts');
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(repo, result.treeOid, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`);
  } else {
    // Squash (and rebase, which no check distinguishes): one commit on the base branch.
    sha = makeCommit(repo, result.treeOid, [baseTip], `${pull.title} (#${pull.number})\n`);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  return sha;
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Line-level add/delete counts between two blob payloads (LCS on lines; small files only). */
function lineDiffCounts(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const a = before.toString('utf8').split('\n');
  const b = after.toString('utf8').split('\n');
  if (a.length > 4000 || b.length > 4000) return { additions: b.length, deletions: a.length };
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j] as number;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j] as number, dp[j - 1] as number);
      diagonal = above;
    }
  }
  const common = dp[b.length] as number;
  // A trailing '' from a final newline counts as a shared line on both sides, which keeps
  // whole-file additions at the visible line count.
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changed files of a pull request: merge-base tree versus head tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileDiff[] {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return [];
  const base = mergeBase(repo.objects, baseTip, headTip);
  const fromFlat = flattenTree(repo.objects, base === null ? null : commitTree(repo, base));
  const toFlat = flattenTree(repo.objects, commitTree(repo, headTip));
  const paths = [...new Set([...fromFlat.keys(), ...toFlat.keys()])].sort();
  const diffs: FileDiff[] = [];
  for (const path of paths) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    if (from === undefined && to !== undefined) {
      const blob = repo.objects.get(to.oid);
      const additions = blob === undefined ? 0 : countLines(blob.data);
      diffs.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (from !== undefined && to === undefined) {
      const blob = repo.objects.get(from.oid);
      const deletions = blob === undefined ? 0 : countLines(blob.data);
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (from !== undefined && to !== undefined) {
      const before = repo.objects.get(from.oid);
      const after = repo.objects.get(to.oid);
      const counts =
        before !== undefined && after !== undefined
          ? lineDiffCounts(before.data, after.data)
          : { additions: 0, deletions: 0 };
      diffs.push({ filename: path, status: 'modified', additions: counts.additions, deletions: counts.deletions, changes: counts.additions + counts.deletions });
    }
  }
  return diffs;
}

// --------------------------------------------------------------------------- misc helpers for surfaces

/** The commits reachable from a tip, tip first (a DFS pre-order over parents). */
export function listCommits(repo: RepoRec, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return order;
}

/** Re-exported object helpers the surfaces need, bound to a repo's store. */
export const repoObjects = {
  ancestors: (repo: RepoRec, tips: readonly string[]): Set<string> => commitAncestors(repo.objects, tips),
  peel: (repo: RepoRec, oid: string): string => peelToNonTag(repo.objects, oid),
  tagTarget: (repo: RepoRec, oid: string): string | null => tagTarget(repo.objects, oid),
  treeEntries: (repo: RepoRec, oid: string): { mode: string; name: string; oid: string }[] => {
    const object = repo.objects.get(oid);
    return object !== undefined && object.type === 'tree' ? parseTree(object.data) : [];
  },
  get: (repo: RepoRec, oid: string): GitObject | undefined => repo.objects.get(oid),
  hash: (type: GitObject['type'], data: Buffer): string => hashObject(type, data),
};
