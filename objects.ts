// Git object model + pack codec. Original implementation for the v3 forge.
// Stdlib only. All objects are immutable, so every parse/flatten/pack-entry
// cache keyed by oid is valid forever and never needs invalidation.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const T_COMMIT = 1;
export const T_TREE = 2;
export const T_BLOB = 3;
export const T_TAG = 4;

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type ObjType = number;

export interface GitObject {
  t: ObjType;
  d: Buffer;
}

export const TYPE_NAMES: Record<number, string> = {
  [T_COMMIT]: 'commit',
  [T_TREE]: 'tree',
  [T_BLOB]: 'blob',
  [T_TAG]: 'tag',
};

export function hashObject(t: ObjType, d: Buffer): string {
  const h = createHash('sha1');
  h.update(TYPE_NAMES[t]);
  h.update(' ');
  h.update(String(d.length));
  h.update('\0');
  h.update(d);
  return h.digest('hex');
}

export function sha1Hex(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

export function oidToBytes(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}

export function bytesToOid(b: Buffer, off = 0): string {
  return b.subarray(off, off + 20).toString('hex');
}

export function isHexOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

// ---------------------------------------------------------------------------
// Commit / tree / tag parsing (memoized; objects never change)
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  authorTime: number;
  committerTime: number;
  message: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
}

const commitCache = new Map<string, CommitInfo>();
const treeCache = new Map<string, TreeEntry[]>();
const tagCache = new Map<string, TagInfo>();

export function parseCommit(oid: string, d: Buffer): CommitInfo {
  const hit = commitCache.get(oid);
  if (hit) return hit;
  const text = d.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    // continuation lines (gpgsig etc.) are ignored: they never carry our fields
  }
  const info: CommitInfo = {
    tree,
    parents,
    author,
    committer,
    authorTime: identityTime(author),
    committerTime: identityTime(committer),
    message,
  };
  commitCache.set(oid, info);
  return info;
}

export function identityTime(line: string): number {
  // "Name <email> 1735689600 +0000" -> 1735689600
  const gt = line.lastIndexOf('>');
  if (gt === -1) return 0;
  const rest = line.slice(gt + 1).trim().split(' ');
  const n = Number.parseInt(rest[0] ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

export interface Identity {
  name: string;
  email: string;
  time: number;
  tz: string;
}

export function parseIdentity(line: string): Identity {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>', lt + 1);
  if (lt === -1 || gt === -1) {
    return { name: line.trim(), email: '', time: 0, tz: '+0000' };
  }
  const name = line.slice(0, lt).trim();
  const email = line.slice(lt + 1, gt);
  const rest = line.slice(gt + 1).trim().split(' ');
  const t = Number.parseInt(rest[0] ?? '', 10);
  return {
    name,
    email,
    time: Number.isFinite(t) ? t : 0,
    tz: rest[1] ?? '+0000',
  };
}

export function parseTree(oid: string, d: Buffer): TreeEntry[] {
  const hit = treeCache.get(oid);
  if (hit) return hit;
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < d.length) {
    const sp = d.indexOf(0x20, i);
    if (sp === -1) throw new Error('malformed tree');
    const mode = d.toString('ascii', i, sp);
    const nul = d.indexOf(0, sp + 1);
    if (nul === -1 || nul + 21 > d.length) throw new Error('malformed tree');
    const name = d.toString('utf8', sp + 1, nul);
    const entryOid = bytesToOid(d, nul + 1);
    entries.push({ mode, name, oid: entryOid });
    i = nul + 21;
  }
  treeCache.set(oid, entries);
  return entries;
}

export function parseTag(oid: string, d: Buffer): TagInfo {
  const hit = tagCache.get(oid);
  if (hit) return hit;
  const text = d.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  const info: TagInfo = { object, type, tag, tagger };
  tagCache.set(oid, info);
  return info;
}

// ---------------------------------------------------------------------------
// Object store: one global content-addressed map shared by all repos.
// ---------------------------------------------------------------------------

export type ObjectStore = Map<string, GitObject>;

export function getObject(store: ObjectStore, oid: string): GitObject | undefined {
  return store.get(oid);
}

export function putObject(store: ObjectStore, t: ObjType, d: Buffer): string {
  const oid = hashObject(t, d);
  if (!store.has(oid)) store.set(oid, { t, d });
  return oid;
}

export function commitInfo(store: ObjectStore, oid: string): CommitInfo | null {
  const o = store.get(oid);
  if (!o || o.t !== T_COMMIT) return null;
  return parseCommit(oid, o.d);
}

export function treeEntries(store: ObjectStore, oid: string): TreeEntry[] | null {
  const o = store.get(oid);
  if (!o || o.t !== T_TREE) return null;
  return parseTree(oid, o.d);
}

// Peel annotated tags until a non-tag object is reached.
export function peel(store: ObjectStore, oid: string): { oid: string; type: number } | null {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    const o = store.get(cur);
    if (!o) return null;
    if (o.t !== T_TAG) return { oid: cur, type: o.t };
    if (seen.has(cur)) return null;
    seen.add(cur);
    cur = parseTag(cur, o.d).object;
  }
}

// ---------------------------------------------------------------------------
// Flattened trees (path -> {oid, mode}), memoized per tree oid.
// Returned maps are shared and must never be mutated by callers.
// ---------------------------------------------------------------------------

export interface FlatEntry {
  oid: string;
  mode: string;
}

const flattenCache = new Map<string, Map<string, FlatEntry>>();

export function flattenTree(store: ObjectStore, treeOid: string): Map<string, FlatEntry> {
  const hit = flattenCache.get(treeOid);
  if (hit) return hit;
  const out = new Map<string, FlatEntry>();
  const stack: Array<{ tree: string; prefix: string }> = [{ tree: treeOid, prefix: '' }];
  while (stack.length > 0) {
    const { tree, prefix } = stack.pop()!;
    const entries = treeEntries(store, tree);
    if (!entries) continue;
    for (const e of entries) {
      const path = prefix + e.name;
      if (e.mode === '40000') {
        // Directories: recurse, but reuse a cached flatten when available.
        const sub = flattenCache.get(e.oid);
        if (sub) {
          for (const [p, v] of sub) out.set(path + '/' + p, v);
        } else {
          stack.push({ tree: e.oid, prefix: path + '/' });
        }
      } else {
        out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
  }
  flattenCache.set(treeOid, out);
  return out;
}

// ---------------------------------------------------------------------------
// Tree construction from a flat map (bottom-up), storing every tree object.
// ---------------------------------------------------------------------------

function treeSortKey(name: string, isDir: boolean): string {
  return isDir ? name + '/' : name;
}

function compareTreeNames(a: string, b: string): number {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ab[i] !== bb[i]) return ab[i] - bb[i];
  }
  return ab.length - bb.length;
}

export function buildTree(store: ObjectStore, entries: TreeEntry[]): string {
  const sorted = [...entries].sort((x, y) =>
    compareTreeNames(treeSortKey(x.name, x.mode === '40000'), treeSortKey(y.name, y.mode === '40000')),
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(oidToBytes(e.oid));
  }
  return putObject(store, T_TREE, Buffer.concat(parts));
}

export function buildTreeFromMap(store: ObjectStore, flat: Map<string, FlatEntry>): string {
  // Group paths by top-level directory, recursively.
  const build = (paths: string[], prefix: string): string => {
    const direct: TreeEntry[] = [];
    const dirs = new Map<string, string[]>();
    for (const p of paths) {
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        const e = flat.get(p)!;
        direct.push({ mode: e.mode, name: rest, oid: e.oid });
      } else {
        const dir = rest.slice(0, slash);
        let list = dirs.get(dir);
        if (!list) {
          list = [];
          dirs.set(dir, list);
        }
        list.push(p);
      }
    }
    for (const [dir, list] of dirs) {
      const sub = build(list, prefix + dir + '/');
      direct.push({ mode: '40000', name: dir, oid: sub });
    }
    return buildTree(store, direct);
  };
  if (flat.size === 0) {
    // Canonical empty tree.
    return putObject(store, T_TREE, Buffer.alloc(0));
  }
  return build([...flat.keys()], '');
}

export function buildCommit(
  store: ObjectStore,
  tree: string,
  parents: string[],
  authorLine: string,
  committerLine: string,
  message: string,
): string {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${authorLine}`, `committer ${committerLine}`, '');
  const head = Buffer.from(lines.join('\n') + '\n', 'utf8');
  return putObject(store, T_COMMIT, Buffer.concat([head, Buffer.from(message, 'utf8')]));
}

// ---------------------------------------------------------------------------
// Pack writing: per-object entry cache (header + deflated body) + assembly.
// ---------------------------------------------------------------------------

export const PACK_DEFLATE_LEVEL = 1;

const packEntryCache = new Map<string, Buffer>();

function varintHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function packEntry(oid: string, obj: GitObject): Buffer {
  const hit = packEntryCache.get(oid);
  if (hit) return hit;
  const header = varintHeader(obj.t, obj.d.length);
  const body = deflateSync(obj.d, { level: PACK_DEFLATE_LEVEL });
  const entry = Buffer.concat([header, body]);
  packEntryCache.set(oid, entry);
  return entry;
}

export function buildPack(store: ObjectStore, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = store.get(oid);
    if (!obj) throw new Error(`missing object ${oid} for pack`);
    parts.push(packEntry(oid, obj));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Pack reading: full OFS/REF delta resolution, incl. thin packs (bases in store).
// ---------------------------------------------------------------------------

export class PackError extends Error {}

const MAX_PACK_OBJECT = 64 * 1024 * 1024;
const MAX_PACK_TOTAL = 256 * 1024 * 1024;

interface RawEntry {
  offset: number;
  type: number; // 1..4 normal, 6 = OFS_DELTA, 7 = REF_DELTA
  size: number; // inflated size of this entry's data (delta payload for deltas)
  data: Buffer; // inflated bytes
  ofsBase?: number;
  refBase?: string;
  nextOffset: number;
}

function readEntryHeader(pack: Buffer, offset: number): { type: number; size: number; next: number } {
  let i = offset;
  if (i >= pack.length) throw new PackError('pack truncated');
  const first = pack[i++];
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  while ((pack[i - 1] & 0x80) !== 0) {
    if (i >= pack.length) throw new PackError('pack truncated');
    const b = pack[i++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next: i };
}

function readOfsBase(pack: Buffer, offset: number, entryStart: number): { baseOffset: number; next: number } {
  let i = offset;
  if (i >= pack.length) throw new PackError('pack truncated');
  let b = pack[i++];
  let base = b & 0x7f;
  while (b & 0x80) {
    if (i >= pack.length) throw new PackError('pack truncated');
    b = pack[i++];
    base = ((base + 1) << 7) | (b & 0x7f);
  }
  // The offset is relative to the START of the delta entry itself
  // (its header position), not to the offset varint.
  return { baseOffset: entryStart - base, next: i };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (i >= delta.length) throw new PackError('delta truncated');
      const b = delta[i++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new PackError('delta base size mismatch');
  if (tgtSize > MAX_PACK_OBJECT) throw new PackError('delta target too large');
  const out = Buffer.alloc(tgtSize);
  let o = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0;
      let len = 0;
      if (op & 0x01) off |= delta[i++]!;
      if (op & 0x02) off |= delta[i++]! << 8;
      if (op & 0x04) off |= delta[i++]! << 16;
      if (op & 0x08) off |= delta[i++]! << 24;
      if (op & 0x10) len |= delta[i++]!;
      if (op & 0x20) len |= delta[i++]! << 8;
      if (op & 0x40) len |= delta[i++]! << 16;
      if (len === 0) len = 0x10000;
      if (off + len > base.length || o + len > tgtSize) throw new PackError('delta copy out of range');
      base.copy(out, o, off, off + len);
      o += len;
    } else if (op !== 0) {
      if (i + op > delta.length || o + op > tgtSize) throw new PackError('delta insert out of range');
      delta.copy(out, o, i, i + op);
      i += op;
      o += op;
    } else {
      throw new PackError('delta opcode 0');
    }
  }
  if (o !== tgtSize) throw new PackError('delta target size mismatch');
  return out;
}

// Parse a pack buffer into resolved objects. `lookup` resolves REF_DELTA
// bases that live in the store (thin packs). Returns objects in pack order.
export function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 32) throw new PackError('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new PackError('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new PackError('unsupported pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart);
  const actual = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!trailer.equals(actual)) throw new PackError('pack trailer checksum mismatch');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let off = 12;
  let total = 0;
  for (let n = 0; n < count; n++) {
    const start = off;
    const { type, size, next } = readEntryHeader(pack, off);
    off = next;
    let ofsBase: number | undefined;
    let refBase: string | undefined;
    if (type === 6) {
      const r = readOfsBase(pack, off, start);
      ofsBase = r.baseOffset;
      off = r.next;
    } else if (type === 7) {
      if (off + 20 > trailerStart) throw new PackError('pack truncated');
      refBase = bytesToOid(pack, off);
      off += 20;
    } else if (type < 1 || type > 4) {
      throw new PackError(`unknown pack object type ${type}`);
    }
    if (size > MAX_PACK_OBJECT) throw new PackError('pack object too large');
    const view = pack.subarray(off, trailerStart);
    let inflated: Buffer;
    let consumed: number;
    try {
      const res = inflateSync(view, { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      inflated = res.buffer;
      consumed = res.engine.bytesWritten;
    } catch {
      throw new PackError('zlib inflate failed');
    }
    if (inflated.length !== size) throw new PackError('inflated size mismatch');
    total += size;
    if (total > MAX_PACK_TOTAL) throw new PackError('pack total too large');
    raw.push({ offset: start, type, size, data: inflated, ofsBase, refBase, nextOffset: off + consumed });
    byOffset.set(start, raw.length - 1);
    off += consumed;
  }
  if (off !== trailerStart) throw new PackError('pack entry/table size mismatch');

  const resolved: Array<GitObject | null> = new Array(raw.length).fill(null);
  const visiting = new Set<number>();
  const resolve = (idx: number): GitObject => {
    const done = resolved[idx];
    if (done) return done;
    if (visiting.has(idx)) throw new PackError('delta cycle');
    visiting.add(idx);
    const e = raw[idx]!;
    let obj: GitObject;
    if (e.type >= 1 && e.type <= 4) {
      obj = { t: e.type, d: e.data };
    } else if (e.type === 6) {
      const baseIdx = byOffset.get(e.ofsBase!);
      if (baseIdx === undefined) throw new PackError('ofs base outside pack');
      const base = resolve(baseIdx);
      obj = { t: base.t, d: applyDelta(base.d, e.data) };
    } else {
      // REF_DELTA: base may be another pack entry (resolved lazily, in any
      // position) or an object already in the store (thin pack).
      let base: GitObject | undefined;
      for (let j = 0; j < raw.length && !base; j++) {
        if (j === idx || visiting.has(j)) continue;
        const cand = resolved[j] ?? resolve(j);
        if (hashObject(cand.t, cand.d) === e.refBase) base = cand;
      }
      if (!base) base = lookup(e.refBase!);
      if (!base) throw new PackError('ref delta base not found');
      obj = { t: base.t, d: applyDelta(base.d, e.data) };
    }
    resolved[idx] = obj;
    visiting.delete(idx);
    return obj;
  };

  const out: GitObject[] = [];
  for (let i = 0; i < raw.length; i++) out.push(resolve(i));
  return out;
}
