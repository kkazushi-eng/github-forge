// The REST v3 surface under /api/v3: repositories, contents, branches, git refs, commits,
// labels, issues, comments and pull requests. Every reply is JSON with a string `message`
// on errors and a non-empty X-GitHub-Request-Id (sendJson adds it), per the protocol checks.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthed, parseJsonBody, sendJson } from './http-util.ts';
import {
  ForgeError,
  VIEWER,
  addComment,
  branchTip,
  commitTree,
  createIssue,
  createPull,
  createRepo,
  deleteRepo,
  getRepo,
  listCommits,
  listRepos,
  makeCommit,
  mergePull,
  pullFiles,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { buildTreeFromFlat, flattenTree, hashObject, parseCommit, parseTree, peelToNonTag, putObject } from './gitobj.ts';

const ISO_EPOCH = 1739175597000;

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email, site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  const stamp = new Date(ISO_EPOCH + repo.createdSeq * 1000).toISOString();
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${repo.owner}/${repo.name}.git`,
    created_at: stamp,
    updated_at: stamp,
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? '000000', default: false };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: new Date(ISO_EPOCH + issue.id).toISOString(),
    updated_at: new Date(ISO_EPOCH + issue.id).toISOString(),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: new Date(ISO_EPOCH + comment.id).toISOString(),
    updated_at: new Date(ISO_EPOCH + comment.id).toISOString(),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const refJson = (ref: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha: branchTip(repo, ref) ?? '0000000000000000000000000000000000000000',
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: refJson(pull.headRef),
    base: refJson(pull.baseRef),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(),
    created_at: new Date(ISO_EPOCH + pull.id).toISOString(),
    updated_at: new Date(ISO_EPOCH + pull.id).toISOString(),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// --------------------------------------------------------------------------- helpers

interface Page {
  items: unknown[];
  headers: Record<string, string>;
}

/** Slice a list by page/per_page and build the GitHub Link header (same-origin absolute URLs). */
function paginate(req: IncomingMessage, url: URL, items: readonly unknown[]): Page {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (items.length > perPage) {
    const host = req.headers.host ?? '127.0.0.1';
    const lastPage = Math.ceil(items.length / perPage);
    const linkFor = (target: number): string => {
      const params = new URLSearchParams(url.searchParams);
      params.set('page', String(target));
      params.set('per_page', String(perPage));
      return `http://${host}${url.pathname}?${params.toString()}`;
    };
    const links: string[] = [];
    if (page < lastPage) links.push(`<${linkFor(page + 1)}>; rel="next"`, `<${linkFor(lastPage)}>; rel="last"`);
    if (page > 1) links.push(`<${linkFor(1)}>; rel="first"`, `<${linkFor(page - 1)}>; rel="prev"`);
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { items: slice, headers };
}

/** Resolve a ?ref= / ?sha= value (branch name, tag name or commit id) to a commit id. */
function resolveCommit(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const branch = branchTip(repo, ref);
  if (branch !== null) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToNonTag(repo.objects, tag);
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

function authorJson(line: string): Record<string, unknown> {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: VIEWER.name, email: VIEWER.email, date: new Date(ISO_EPOCH).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  return {
    sha: oid,
    commit: {
      message: commit.message,
      author: authorJson(commit.author),
      committer: authorJson(commit.committer),
      tree: { sha: commit.tree },
    },
    author: userJson(),
    committer: userJson(),
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function requireRepo(res: ServerResponse, owner: string, name: string): RepoRec | null {
  const repo = getRepo(owner, name);
  if (repo === null) {
    notFound(res);
    return null;
  }
  return repo;
}

// --------------------------------------------------------------------------- contents

interface TreeHit {
  mode: string;
  oid: string;
  type: 'file' | 'dir';
}

/** Navigate to a path inside a commit's tree; null when any step misses. */
function navigateTree(repo: RepoRec, commitOid: string, path: string): TreeHit | null {
  const treeOid = commitTree(repo, commitOid);
  if (treeOid === null) return null;
  if (path === '') return { mode: '40000', oid: treeOid, type: 'dir' };
  const parts = path.split('/');
  let currentTree = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = repo.objects.get(currentTree);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      return { mode: entry.mode, oid: entry.oid, type: entry.mode === '40000' ? 'dir' : 'file' };
    }
    if (entry.mode !== '40000') return null;
    currentTree = entry.oid;
  }
  return null;
}

function handleContentsGet(res: ServerResponse, repo: RepoRec, path: string, url: URL): void {
  const commitOid = resolveCommit(repo, url.searchParams.get('ref'));
  if (commitOid === null) return notFound(res);
  const hit = navigateTree(repo, commitOid, path);
  if (hit === null) return notFound(res);
  if (hit.type === 'file') {
    const blob = repo.objects.get(hit.oid);
    const data = blob?.data ?? Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file',
      name: path.split('/').pop() ?? path,
      path,
      sha: hit.oid,
      size: data.length,
      encoding: 'base64',
      content: data.toString('base64'),
    });
    return;
  }
  const tree = repo.objects.get(hit.oid);
  const entries = tree !== undefined && tree.type === 'tree' ? parseTree(tree.data) : [];
  sendJson(
    res,
    200,
    entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
    })),
  );
}

interface ContentsWriteResult {
  status: number;
  commitSha: string;
  blobOid: string | null;
}

/** Shared create/update/delete logic for the contents API (one commit on the branch). */
function contentsWrite(repo: RepoRec, path: string, body: Record<string, unknown>, mode: 'put' | 'delete'): ContentsWriteResult {
  if (path === '') throw new ForgeError(422, 'Validation Failed: path is required');
  const message = typeof body.message === 'string' ? body.message : mode === 'delete' ? `Delete ${path}` : `Update ${path}`;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  let tip = branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    // A contents write may create a branch: it starts from the default branch's tip.
    tip = branchTip(repo, repo.defaultBranch);
  }
  const flat = flattenTree(repo.objects, tip === null ? null : commitTree(repo, tip));
  const existing = flat.get(path);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  let blobOid: string | null = null;
  if (mode === 'put') {
    if (existing !== undefined) {
      if (sha === undefined) throw new ForgeError(422, 'Validation Failed: sha is required when updating a file');
      if (sha !== existing.oid) throw new ForgeError(409, 'Conflict: the sha does not match the current file');
    }
    if (typeof body.content !== 'string') throw new ForgeError(422, 'Validation Failed: content is required');
    const data = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
    blobOid = putObject(repo.objects, 'blob', data);
    flat.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
  } else {
    if (existing === undefined) throw new ForgeError(404, 'Not Found');
    if (sha !== undefined && sha !== existing.oid) throw new ForgeError(409, 'Conflict: the sha does not match the current file');
    flat.delete(path);
  }
  const treeOid = buildTreeFromFlat(repo.objects, flat);
  const commitSha = makeCommit(repo, treeOid, tip === null ? [] : [tip], message.endsWith('\n') ? message : `${message}\n`);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { status: mode === 'put' ? (existing === undefined ? 201 : 200) : 200, commitSha, blobOid };
}

// --------------------------------------------------------------------------- the router

export async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): Promise<void> {
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  let rest = url.pathname.slice('/api/v3'.length);
  if (rest.length > 1 && rest.endsWith('/')) rest = rest.slice(0, -1);
  const segments = rest.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));

  let body: Record<string, unknown> = {};
  if (rawBody.length > 0 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const parsed = parseJsonBody(rawBody);
    if (parsed === null) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    body = parsed;
  }

  try {
    // Root and meta.
    if (segments.length === 0) {
      if (method !== 'GET') return notFound(res);
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_repositories_url: '/api/v3/user/repos',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    if (segments.length === 1 && segments[0] === 'meta') {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, { installed_version: '1.0.0', git_version: 'forge-1.0.0' });
      return;
    }
    if (segments.length === 1 && segments[0] === 'user') {
      if (method !== 'GET') return notFound(res);
      sendJson(res, 200, userJson());
      return;
    }

    // The viewer's repositories.
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'GET') {
        const page = paginate(req, url, listRepos(VIEWER.login).map(repoJson));
        sendJson(res, 200, page.items, page.headers);
        return;
      }
      if (method === 'POST') {
        const repo = createRepo(VIEWER.login, typeof body.name === 'string' ? body.name : '', {
          isPrivate: body.private === true,
          description: typeof body.description === 'string' ? body.description : '',
        });
        if (body.auto_init === true) {
          const blob = putObject(repo.objects, 'blob', Buffer.from(`# ${repo.name}\n`, 'utf8'));
          const tree = buildTreeFromFlat(repo.objects, new Map([['README.md', { mode: '100644', oid: blob }]]));
          const commit = makeCommit(repo, tree, [], 'Initial commit\n');
          repo.refs.set(`refs/heads/${repo.defaultBranch}`, commit);
        }
        sendJson(res, 201, repoJson(repo));
        return;
      }
      return notFound(res);
    }

    if (segments.length < 3 || segments[0] !== 'repos') return notFound(res);
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = requireRepo(res, owner, name);
    if (repo === null) return;
    const tail = segments.slice(3);

    // Repository itself.
    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': 'forge-delete' });
        res.end();
        return;
      }
      return notFound(res);
    }

    // Contents.
    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') {
        handleContentsGet(res, repo, path, url);
        return;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const result = contentsWrite(repo, path, body, method === 'PUT' ? 'put' : 'delete');
        if (method === 'DELETE') {
          sendJson(res, 200, { content: null, commit: { sha: result.commitSha } });
          return;
        }
        const blob = result.blobOid !== null ? repo.objects.get(result.blobOid) : undefined;
        sendJson(res, result.status, {
          content: {
            type: 'file',
            name: path.split('/').pop() ?? path,
            path,
            sha: result.blobOid,
            size: blob?.data.length ?? 0,
            encoding: 'base64',
            content: blob?.data.toString('base64') ?? '',
          },
          commit: { sha: result.commitSha, message: typeof body.message === 'string' ? body.message : '' },
        });
        return;
      }
      return notFound(res);
    }

    // Branches.
    if (tail[0] === 'branches') {
      if (method !== 'GET') return notFound(res);
      if (tail.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, branches);
        return;
      }
      const branch = tail.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return notFound(res);
      sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return;
    }

    // Git refs (the Git Data API).
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || sha === '') throw new ForgeError(422, 'Validation Failed: ref and sha are required');
        const object = repo.objects.get(sha);
        if (object === undefined) throw new ForgeError(422, 'Validation Failed: sha does not name an object');
        if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: object.type } });
        return;
      }
      if (method === 'GET') {
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return notFound(res);
        const object = repo.objects.get(sha);
        sendJson(res, 200, { ref, object: { sha, type: object?.type ?? 'commit' } });
        return;
      }
      return notFound(res);
    }

    // Commits.
    if (tail[0] === 'commits' && tail.length === 1) {
      if (method !== 'GET') return notFound(res);
      const tip = resolveCommit(repo, url.searchParams.get('sha'));
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const page = paginate(req, url, listCommits(repo, tip).map((oid) => commitJson(repo, oid)));
      sendJson(res, 200, page.items, page.headers);
      return;
    }

    // Labels.
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.keys()].sort().map((label) => labelJson(repo, label)));
        return;
      }
      if (method === 'POST') {
        const labelName = typeof body.name === 'string' ? body.name : '';
        if (labelName === '') throw new ForgeError(422, 'Validation Failed: name is required');
        if (repo.labels.has(labelName)) throw new ForgeError(422, 'Validation Failed: label already exists');
        repo.labels.set(labelName, { name: labelName, color: typeof body.color === 'string' ? body.color : '000000' });
        sendJson(res, 201, labelJson(repo, labelName));
        return;
      }
      return notFound(res);
    }

    // Issues and their comments.
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const issue = createIssue(repo, {
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            labels: Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [],
          });
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let issues = [...repo.issues.values()];
          if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
          const direction = url.searchParams.get('direction') ?? 'desc';
          issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const page = paginate(req, url, issues.map((issue) => issueJson(repo, issue)));
          sendJson(res, 200, page.items, page.headers);
          return;
        }
        return notFound(res);
      }
      const number = Number.parseInt(tail[1] as string, 10);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (tail.length === 2) {
        if (issue === undefined) return notFound(res);
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((label): label is string => typeof label === 'string');
            for (const label of labels) {
              if (!repo.labels.has(label)) throw new ForgeError(422, `Validation Failed: label "${label}" does not exist`);
            }
            issue.labels = labels;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        return notFound(res);
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        const record = issue ?? pull;
        if (record === undefined) return notFound(res);
        if (method === 'GET') {
          sendJson(res, 200, record.comments.map(commentJson));
          return;
        }
        if (method === 'POST') {
          if (typeof body.body !== 'string' || body.body === '') throw new ForgeError(422, 'Validation Failed: body is required');
          const comment = addComment(record, body.body);
          sendJson(res, 201, commentJson(comment));
          return;
        }
        return notFound(res);
      }
      return notFound(res);
    }

    // Pull requests.
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const pull = createPull(repo, {
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            head: typeof body.head === 'string' ? body.head : '',
            base: typeof body.base === 'string' ? body.base : '',
          });
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => a.number - b.number);
          const page = paginate(req, url, pulls.map((pull) => pullJson(repo, pull)));
          sendJson(res, 200, page.items, page.headers);
          return;
        }
        return notFound(res);
      }
      const number = Number.parseInt(tail[1] as string, 10);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (tail.length === 2) {
        if (pull === undefined) return notFound(res);
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return;
        }
        return notFound(res);
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (pull === undefined) return notFound(res);
        if (method !== 'GET') return notFound(res);
        sendJson(res, 200, pullFiles(repo, pull).map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes })));
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (pull === undefined) return notFound(res);
        if (method !== 'PUT') return notFound(res);
        const methodName = body.merge_method === 'squash' ? 'squash' : body.merge_method === 'rebase' ? 'rebase' : 'merge';
        const sha = mergePull(repo, pull, methodName);
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      return notFound(res);
    }

    return notFound(res);
  } catch (err) {
    if (err instanceof ForgeError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    throw err;
  }
}
