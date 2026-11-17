// Git smart HTTP, implemented in-process: protocol v2 for upload-pack (advertisement,
// ls-refs, fetch with shallow/deepen semantics) and protocol v0 for receive-pack (push
// with report-status inside side-band-64k). No git binary anywhere: packs are built and
// parsed by gitobj.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthed, sendBytes, sendJson } from './http-util.ts';
import {
  ZERO_OID,
  commitAncestors,
  commitDistances,
  objectClosure,
  parseCommit,
  parseTree,
  peelToNonTag,
  readPack,
  tagTarget,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { getRepo, type RepoRec } from './store.ts';

const AGENT = 'github-forge/1.0';

// --------------------------------------------------------------------------- pkt-lines

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface PktLine {
  /** 'data' | 'flush' | 'delim' */
  kind: 'data' | 'flush' | 'delim';
  data: Buffer;
}

/** Parse pkt-lines from `offset`; stops after a flush/delim (returned as the last line). */
function parsePkts(buffer: Buffer, offset: number): { lines: PktLine[]; next: number } {
  const lines: PktLine[] = [];
  let cursor = offset;
  while (cursor < buffer.length) {
    if (cursor + 4 > buffer.length) throw new Error('truncated pkt-line');
    const lengthText = buffer.subarray(cursor, cursor + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new Error('invalid pkt-line length');
    const length = Number.parseInt(lengthText, 16);
    if (length === 0) {
      lines.push({ kind: 'flush', data: Buffer.alloc(0) });
      cursor += 4;
      return { lines, next: cursor };
    }
    if (length === 1) {
      lines.push({ kind: 'delim', data: Buffer.alloc(0) });
      cursor += 4;
      return { lines, next: cursor };
    }
    if (length === 2) {
      cursor += 4;
      continue; // response-end: treat as a separator and keep reading
    }
    if (length < 4 || cursor + length > buffer.length) throw new Error('pkt-line overruns the body');
    lines.push({ kind: 'data', data: buffer.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { lines, next: cursor };
}

function dataLines(lines: PktLine[]): string[] {
  return lines.filter((line) => line.kind === 'data').map((line) => line.data.toString('utf8').replace(/\n$/, ''));
}

/** Wrap bytes in side-band band-1 packets (each payload prefixed with byte 1). */
function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, offset + CHUNK);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- advertisements

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** HEAD first, then every ref in name order, with peeled lines after annotated tags. */
function refLines(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) lines.push({ oid: headOid, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    lines.push({ oid, name });
    const target = tagTarget(repo.objects, oid);
    if (target !== null) lines.push({ oid: peelToNonTag(repo.objects, oid), name: `${name}^{}` });
  }
  return lines;
}

function advertiseV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta object-format=sha1 agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const lines = refLines(repo);
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    lines.forEach((line, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pkt(`${line.oid} ${line.name}${suffix}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertiseV2(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

// --------------------------------------------------------------------------- ls-refs

function handleLsRefs(repo: RepoRec, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pkt(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pkt(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const target = tagTarget(repo.objects, oid);
      if (target !== null) line += ` peeled:${peelToNonTag(repo.objects, oid)}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
  deepen: number | null;
  deepenRelative: boolean;
}

interface FetchPlan {
  objects: GitObject[];
  shallowInfo: string[] | null;
}

function planFetch(repo: RepoRec, request: FetchRequest): FetchPlan {
  const store = repo.objects;
  const shallowMode = request.depth !== null || request.deepen !== null || request.shallows.length > 0;
  const peeledWants = request.wants.map((want) => peelToNonTag(store, want));
  let effectiveDepth = request.depth ?? request.deepen;
  if (effectiveDepth !== null && request.deepenRelative && request.shallows.length > 0) {
    // deepen-relative (the git CLI's spelling): deepen N steps past the current
    // boundary, whose distance from the wants sets the base depth. The suite's client
    // never sends it and reads plain deepen as an absolute depth.
    const distances = commitDistances(store, peeledWants);
    let base = 0;
    for (const shallow of request.shallows) {
      const distance = distances.get(peelToNonTag(store, shallow));
      if (distance !== undefined && distance > base) base = distance;
    }
    effectiveDepth += base;
  }
  // What the client already holds: the closure of its haves and shallow tips, CUT at
  // the shallow boundary — a boundary commit contributes itself and its tree, but its
  // ancestors are exactly what the client does not have (a plain closure of a have
  // above the boundary would wrongly exclude the history an unshallow fetch exists
  // to deliver).
  const shallowSet = new Set(request.shallows.map((oid) => peelToNonTag(store, oid)));
  const haveClosure = ((): Set<string> => {
    const seen = new Set<string>();
    const stack = [...request.haves, ...request.shallows];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (!shallowSet.has(oid)) stack.push(...commit.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = tagTarget(store, oid);
        if (target !== null) stack.push(target);
      }
    }
    return seen;
  })();
  const haveCommits = new Set([...haveClosure].filter((oid) => store.get(oid)?.type === 'commit'));

  let includedCommits: Set<string>;
  if (effectiveDepth !== null) {
    includedCommits = new Set<string>();
    // Distances are measured from the wants peeled to commits (a want may be a tag),
    // and the BFS stops at the depth window: a depth-1 clone of a long history must
    // not walk all of it.
    for (const [oid, distance] of commitDistances(store, peeledWants, effectiveDepth)) {
      if (distance <= effectiveDepth) includedCommits.add(oid);
    }
  } else {
    includedCommits = commitAncestors(store, peeledWants);
  }
  for (const oid of haveCommits) includedCommits.delete(oid);

  // The delivered set: the included commits and their tree closures ONLY — a plain
  // closure of the commits would follow parents past the depth window and hand a
  // shallow client history it must not see.
  const objectSet = new Set<string>();
  for (const oid of includedCommits) {
    objectSet.add(oid);
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const treeOid of objectClosure(store, [parseCommit(object.data).tree])) objectSet.add(treeOid);
    }
  }
  // A want that names a non-commit object directly (a tree or blob tag target) seeds
  // its own closure.
  for (const want of request.wants) {
    const peeled = peelToNonTag(store, want);
    const object = store.get(peeled);
    if (object !== undefined && object.type !== 'commit') {
      for (const oid of objectClosure(store, [peeled])) objectSet.add(oid);
    }
  }
  // Annotated tags whose target chain reaches the included set ride along. The scan
  // costs a full closure of the wants, so it runs only when a tag is actually in
  // play (a want naming a tag, or any ref pointing at one).
  const anyTags =
    request.wants.some((want) => store.get(want)?.type === 'tag') ||
    [...repo.refs.values()].some((oid) => store.get(oid)?.type === 'tag');
  if (anyTags) {
    const wantClosure = objectClosure(store, request.wants);
    let grew = true;
    while (grew) {
      grew = false;
      for (const oid of wantClosure) {
        if (objectSet.has(oid)) continue;
        const object = store.get(oid);
        if (object === undefined || object.type !== 'tag') continue;
        const target = tagTarget(store, oid);
        if (target !== null && (objectSet.has(target) || includedCommits.has(target))) {
          objectSet.add(oid);
          grew = true;
        }
      }
    }
  }
  for (const oid of haveClosure) objectSet.delete(oid);

  let shallowInfo: string[] | null = null;
  if (shallowMode) {
    shallowInfo = [];
    // The new boundary: a delivered commit whose parent is neither delivered nor
    // already held — the client's history is still cut there.
    const boundary = new Set<string>();
    for (const oid of includedCommits) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const cut = parseCommit(object.data).parents.some((parent) => !includedCommits.has(parent) && !haveCommits.has(parent) && store.has(parent));
      if (cut) boundary.add(oid);
    }
    for (const oid of [...boundary].sort()) shallowInfo.push(`shallow ${oid}`);
    // A former boundary stops being shallow when this fetch leaves it connected:
    // it is held or delivered, it is not the new boundary, and every parent of it is
    // now held or delivered.
    for (const raw of request.shallows) {
      const oid = peelToNonTag(store, raw);
      if (boundary.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (!includedCommits.has(oid) && !haveCommits.has(oid)) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => includedCommits.has(parent) || haveCommits.has(parent))) {
        shallowInfo.push(`unshallow ${oid}`);
      }
    }
  }

  const objects: GitObject[] = [];
  for (const oid of objectSet) {
    const object = store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const rank = (object: GitObject): number => (object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'tag' ? 2 : 3);
  objects.sort((a, b) => rank(a) - rank(b));
  return { objects, shallowInfo };
}

function fetchPackfileSection(repo: RepoRec, request: FetchRequest): Buffer {
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  // No acknowledgments section here: a client that sent done has either finished
  // negotiating (the git CLI's second flight, which expects the pack next) or never
  // negotiated (the suite's one-shot client, whose parser does not need one). The
  // no-done negotiation flight is answered in handleFetchV2.
  if (plan.shallowInfo !== null) {
    parts.push(pkt('shallow-info\n'));
    for (const line of plan.shallowInfo) parts.push(pkt(`${line}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sidebandWrap(writePack(plan.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function parseFetchArgs(args: string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallows: [], depth: null, deepen: null, deepenRelative: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallows.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) request.deepen = Number.parseInt(arg.slice(7), 10) || null;
    else if (arg === 'deepen-relative') request.deepenRelative = true;
  }
  return request;
}


function handleFetchV2(repo: RepoRec, args: string[]): Buffer {
  const request = parseFetchArgs(args);
  if (!args.includes('done')) {
    // A negotiating client (the git CLI) sends wants/haves first and done in a second
    // flight: this flight answers only the acknowledgments section, closed by a
    // response-end packet. A client that sends done at once (the suite's) gets the
    // whole response from fetchPackfileSection.
    const parts: Buffer[] = [pkt('acknowledgments\n')];
    const acks = request.haves.filter((oid) => repo.objects.has(oid));
    if (acks.length === 0) parts.push(pkt('NAK\n'));
    else for (const oid of acks) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(FLUSH);
    // The HTTP body simply ends here: remote-curl synthesises the response-end for
    // fetch-pack at EOF (a literal 0002 in the body is rejected as unexpected).
    return Buffer.concat(parts);
  }
  return fetchPackfileSection(repo, request);
}

function handleFetchV0(repo: RepoRec, firstSection: string[], secondSection: string[]): Buffer {
  const request: FetchRequest = { wants: [], haves: [], shallows: [], depth: null, deepen: null, deepenRelative: false };
  for (const line of firstSection) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      request.wants.push(oid);
    } else if (line.startsWith('shallow ')) request.shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7), 10) || null;
  }
  for (const line of secondSection) {
    if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
  }
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (plan.shallowInfo !== null) {
    for (const line of plan.shallowInfo) parts.push(pkt(`${line}\n`));
  }
  parts.push(pkt('NAK\n'));
  parts.push(sidebandWrap(writePack(plan.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: RepoRec, body: Buffer): Buffer {
  const first = parsePkts(body, 0);
  const commandLines = dataLines(first.lines);
  let packStart = first.next;
  const commands: PushCommand[] = [];
  let requestedCaps = '';
  commandLines.forEach((line, index) => {
    let text = line;
    if (index === 0) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        requestedCaps = text.slice(nul + 1);
        text = text.slice(0, nul);
      }
    }
    const parts = text.trim().split(/\s+/);
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  });
  const caps = new Set(requestedCaps.split(/\s+/).filter((cap) => cap !== ''));
  const wantsReport = caps.has('report-status') || caps.has('report-status-v2');
  const wantsSideband = caps.has('side-band-64k');

  let unpackOk = true;
  let unpackDetail = 'ok';
  const pack = body.subarray(packStart);
  if (pack.length > 0) {
    try {
      const result = readPack(repo.objects, pack);
      for (const [oid, object] of result.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    const succeed = (): void => {
      results.push({ ref: command.ref, ok: true, reason: '' });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) fail('reference does not exist');
      else {
        repo.refs.delete(command.ref);
        succeed();
      }
      continue;
    }
    if (command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    const object = repo.objects.get(command.newOid);
    if (object === undefined) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        fail('invalid object');
        continue;
      }
      if (command.oldOid !== ZERO_OID && !commitAncestors(repo.objects, [command.newOid]).has(command.oldOid)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    succeed();
  }

  if (!wantsReport) return Buffer.alloc(0);
  const reportParts: Buffer[] = [pkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(FLUSH);
  const report = Buffer.concat(reportParts);
  // With side-band-64k the report rides band 1, and the sideband stream itself is
  // flush-terminated (the suite's demuxer tolerates either; the git CLI requires it).
  return wantsSideband ? Buffer.concat([sidebandWrap(report), FLUSH]) : report;
}

// --------------------------------------------------------------------------- the router

export async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer, owner: string, repoName: string, sub: string): Promise<void> {
  if (!isAuthed(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const repo = getRepo(owner, repoName);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  try {
    if (method === 'GET' && sub === '/info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Unsupported service' });
        return;
      }
      const protocol = req.headers['git-protocol'];
      const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
      if (service === 'git-upload-pack' && wantsV2) {
        sendBytes(res, 200, advertiseV2(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendBytes(res, 200, advertiseV0(repo, service), `application/x-${service}-advertisement`);
      }
      return;
    }
    if (method === 'POST' && sub === '/git-upload-pack') {
      const firstSection = parsePkts(body, 0);
      const firstLines = dataLines(firstSection.lines);
      const firstLine = firstLines[0] ?? '';
      if (firstLine.startsWith('command=')) {
        const command = firstLine.slice('command='.length);
        const rest = parsePkts(body, firstSection.next);
        const args = dataLines(rest.lines);
        if (command === 'ls-refs') {
          sendBytes(res, 200, handleLsRefs(repo, args), 'application/x-git-upload-pack-result');
          return;
        }
        if (command === 'fetch') {
          sendBytes(res, 200, handleFetchV2(repo, args), 'application/x-git-upload-pack-result');
          return;
        }
        sendJson(res, 400, { message: `Unsupported command ${command}` });
        return;
      }
      // Protocol v0: wants in the first section, haves + done in the second.
      const secondSection = parsePkts(body, firstSection.next);
      const secondLines = dataLines(secondSection.lines);
      sendBytes(res, 200, handleFetchV0(repo, firstLines, secondLines), 'application/x-git-upload-pack-result');
      return;
    }
    if (method === 'POST' && sub === '/git-receive-pack') {
      const report = handleReceivePack(repo, body);
      sendBytes(res, 200, report, 'application/x-git-receive-pack-result');
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
  } catch (err) {
    // A malformed body must never take the server down (the suite probes exactly that).
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'Bad request' });
  }
}
