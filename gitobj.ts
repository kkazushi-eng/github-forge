// The git object model, implemented in-process (no git binary): SHA-1 object ids, trees,
// commits, annotated tags, packfile writing (never any deltas) and packfile reading (with
// OFS_DELTA / REF_DELTA application, including thin packs against the existing store).
//
// Everything here works on a plain Map<oid, GitObject> so the same code serves a repository's
// live store and a throwaway mirror of a pack being unpacked.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export type ObjectMap = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a would-be object: sha1 of "<type> <size>\0" + payload. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object (idempotently) and answer its id. */
export function putObject(store: ObjectMap, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// --------------------------------------------------------------------------- trees

export interface TreeEntry {
  /** The mode as written in the tree object: '100644', '100755', '120000', '40000', '160000'. */
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: byte order, with directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** One file in a flattened tree: its blob (or gitlink) oid and mode. */
export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (recursively) into path -> entry. A missing tree flattens to empty. */
export function flattenTree(store: ObjectMap, treeOid: string | null): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { mode: entry.mode, oid: entry.oid });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

/** Rebuild (and store) nested trees from a flattened path map; answers the root tree id. */
export function buildTreeFromFlat(store: ObjectMap, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return emit(root);
}

// --------------------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The object an annotated tag points at (one peel step), or null for non-tags. */
export function tagTarget(store: ObjectMap, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
  return match === null ? null : (match[1] as string);
}

/** Peel an oid through annotated tags to the first non-tag object. */
export function peelToNonTag(store: ObjectMap, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const next = tagTarget(store, current);
    if (next === null) return current;
    current = next;
  }
  return current;
}

// --------------------------------------------------------------------------- reachability

/** Every commit reachable from the tips (tips included), following parents. */
export function commitAncestors(store: ObjectMap, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** BFS distance (1 = a tip itself) from the tips to every reachable commit. */
export function commitDistances(store: ObjectMap, tips: readonly string[]): Map<string, number> {
  const distance = new Map<string, number>();
  let frontier = [...new Set(tips)];
  for (const tip of frontier) distance.set(tip, 1);
  let depth = 1;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, depth + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return distance;
}

/** Every object (commits, trees, blobs, tags) reachable from the given root objects. */
export function objectClosure(store: ObjectMap, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = tagTarget(store, oid);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors (commit graph). */
export function isAncestor(store: ObjectMap, ancestor: string, descendant: string): boolean {
  return commitAncestors(store, [descendant]).has(ancestor);
}

/** A best common ancestor of two commits (BFS from b, first hit in a's ancestor set). */
export function mergeBase(store: ObjectMap, a: string, b: string): string | null {
  const ancestorsOfA = commitAncestors(store, [a]);
  const seen = new Set<string>();
  let frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const object = store.get(oid);
      if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
  }
  return null;
}

// --------------------------------------------------------------------------- deltas

/** Apply a git delta buffer to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} != ${base.length}`);
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          copyOffset |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          copySize |= (delta[offset] as number) << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

// --------------------------------------------------------------------------- packfiles

/** Serialise objects into a version-2 pack with no deltas. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const first = (TYPE_TO_CODE[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    if (size === 0) {
      headBytes.push(first);
    } else {
      headBytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        headBytes.push(size > 0 ? byte | 0x80 : byte);
      }
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one deflate stream starting at `start`, finding its compressed length by probing:
 * inflateSync ignores trailing bytes but throws on a truncated stream, so the smallest
 * successful length is the stream's true end.
 */
function inflateOne(buffer: Buffer, start: number): { data: Buffer; next: number } {
  const remaining = buffer.length - start;
  // Probe upward for a length that inflates, remembering the largest failure...
  let bad = 0; // a length known to fail (0 = none tried)
  let good = -1; // a length known to succeed
  let probe = Math.min(remaining, 64);
  while (good === -1) {
    try {
      inflateSync(buffer.subarray(start, start + probe));
      good = probe;
    } catch {
      if (probe >= remaining) throw new Error('corrupt deflate stream in pack');
      bad = probe;
      probe = Math.min(remaining, probe * 2);
    }
  }
  // ...then binary-search (bad, good] for the smallest successful length: the stream's end.
  let low = bad + 1;
  let high = good;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buffer.subarray(start, start + mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  const data = inflateSync(buffer.subarray(start, start + low));
  return { data, next: start + low };
}

export interface PackReadResult {
  /** The pack's objects by id (deltas already resolved). */
  objects: ObjectMap;
  /** Bytes consumed, trailer included. */
  bytesRead: number;
}

/**
 * Parse a pack starting at `start`. Delta bases may live inside the pack (OFS/REF) or in
 * `baseStore` (a thin pack against the repository). Throws on any corruption.
 */
export function readPack(baseStore: ObjectMap, buffer: Buffer, start = 0): PackReadResult {
  if (buffer.length - start < 12 + 20) throw new Error('pack too short');
  if (buffer.subarray(start, start + 4).toString('ascii') !== 'PACK') throw new Error('pack header missing');
  const version = buffer.readUInt32BE(start + 4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(start + 8);
  let offset = start + 12;
  interface RawEntry {
    type: ObjectType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    entryOffset: number;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = buffer[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = buffer[offset] as number;
      offset += 1;
    }
    let entry: RawEntry;
    if (typeCode === 6) {
      let back = buffer[offset] as number;
      offset += 1;
      let baseBack = back & 0x7f;
      while (back & 0x80) {
        back = buffer[offset] as number;
        offset += 1;
        baseBack = ((baseBack + 1) << 7) | (back & 0x7f);
      }
      const inflated = inflateOne(buffer, offset);
      offset = inflated.next;
      entry = { type: 'ofs-delta', data: inflated.data, baseOffset: entryOffset - baseBack, entryOffset };
    } else if (typeCode === 7) {
      const baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateOne(buffer, offset);
      offset = inflated.next;
      entry = { type: 'ref-delta', data: inflated.data, baseOid, entryOffset };
    } else {
      const type = CODE_TO_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateOne(buffer, offset);
      offset = inflated.next;
      entry = { type, data: inflated.data, entryOffset };
    }
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const trailer = buffer.subarray(offset, offset + 20);
  const digest = createHash('sha1').update(buffer.subarray(start, offset)).digest();
  if (trailer.length === 20 && !trailer.equals(digest)) throw new Error('pack checksum mismatch');
  offset += 20;

  const resolved = new Map<number, GitObject>();
  const objects: ObjectMap = new Map();
  const resolve = (entry: RawEntry): GitObject => {
    const cached = resolved.get(entry.entryOffset);
    if (cached !== undefined) return cached;
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base = objects.get(entry.baseOid as string);
      if (base === undefined) base = baseStore.get(entry.baseOid as string);
      if (base === undefined) {
        // The base may be another pack entry not yet resolved into `objects`.
        for (const candidate of raw) {
          if (candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta') {
            if (hashObject(candidate.type, candidate.data) === entry.baseOid) {
              base = resolve(candidate);
              break;
            }
          }
        }
      }
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not found`);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved.set(entry.entryOffset, object);
    objects.set(hashObject(object.type, object.data), object);
    return object;
  };
  for (const entry of raw) resolve(entry);
  return { objects, bytesRead: offset - start };
}
