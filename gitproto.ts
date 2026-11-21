// Git smart-HTTP protocol (v0 + v2): advertisements, ls-refs, fetch
// planning, and receive-pack. Original implementation written for v3.
//
// Caching strategy: advertisements and ls-refs responses are cached per
// (repo, generation) and fetch responses per (generation + full request
// key). Refs only change through pushes / merges / ref edits, each of
// which bumps repo.gen, so cache invalidation is exact.

import {
  PackError,
  T_BLOB,
  T_COMMIT,
  T_TAG,
  T_TREE,
  ZERO_OID,
  buildPack,
  commitInfo,
  hashObject,
  isHexOid,
  parseTag,
  parseTree,
  peel,
  readPack,
  type GitObject,
} from './objects.ts';
import { Forge, type Repo } from './forge.ts';

export const AGENT = 'forge-v3/1.0';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pkt(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export class PktError extends Error {}

// Parse pkt-lines from the start of buf. Returns the list of packets
// (each {kind: 'data'|'flush'|'delim', data}) and the offset just past
// the last packet consumed. Stops after the first flush packet when
// stopAtFlush is set (command sections); otherwise parses until the
// buffer is exhausted or a packet is malformed.
export function parsePackets(
  buf: Buffer,
  stopAtFlush: boolean,
): { packets: Array<{ kind: 'data' | 'flush' | 'delim'; data: Buffer }>; offset: number } {
  const packets: Array<{ kind: 'data' | 'flush' | 'delim'; data: Buffer }> = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new PktError('truncated pkt-line');
    // Parse the 4-hex-digit length straight from the bytes instead of
    // allocating a string + regex + parseInt per packet. Node's 'ascii'
    // decoding masks bytes to 7 bits, so the old regex test on the decoded
    // string accepted e.g. 0xB0 as '0'; the & 0x7f mask below keeps the
    // accept/reject behavior byte-identical (including malformed input).
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const c = buf[off + i]! & 0x7f;
      let v: number;
      if (c >= 48 && c <= 57) v = c - 48; // '0'-'9'
      else if (c >= 97 && c <= 102) v = c - 87; // 'a'-'f'
      else if (c >= 65 && c <= 70) v = c - 55; // 'A'-'F'
      else throw new PktError('bad pkt-line length');
      len = (len << 4) | v;
    }
    if (len === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      off += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new PktError('pkt-line length out of range');
    packets.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, offset: off };
}

function pktText(p: { data: Buffer }): string {
  return p.data.toString('utf8');
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const V2_ADVERTISEMENT = Buffer.concat([
  pkt('version 2\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow filter\n'),
  pkt('object-format=sha1\n'),
  pkt(`agent=${AGENT}\n`),
  FLUSH,
]);

export function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

const UPLOAD_CAPS = (symref: string): string =>
  `symref=HEAD:${symref} side-band-64k thin-pack ofs-delta shallow object-format=sha1 agent=${AGENT}`;
const RECEIVE_CAPS = (symref: string): string =>
  `symref=HEAD:${symref} report-status side-band-64k delete-refs ofs-delta object-format=sha1 agent=${AGENT}`;

interface AdvertCache {
  gen: number;
  upload?: Buffer;
  receive?: Buffer;
}

const advertCache = new Map<number, AdvertCache>();

// Build v0 advertisement with peeled tag lines (needs the object store).
// Only the requested variant is built on a cache miss; the other variant
// is built lazily on first request. The bytes are identical to building
// both eagerly: buildV0 is deterministic for a given (repo, service, gen),
// and refs cannot change without bumping gen (which drops the entry).
export function v0Advertisement(forge: Forge, repo: Repo, service: 'upload' | 'receive'): Buffer {
  const cached = advertCache.get(repo.id);
  if (cached && cached.gen === repo.gen) {
    const hit = service === 'upload' ? cached.upload : cached.receive;
    if (hit) return hit;
    const built = buildV0(forge, repo, service);
    if (service === 'upload') cached.upload = built;
    else cached.receive = built;
    return built;
  }
  const entry: AdvertCache = { gen: repo.gen };
  const built = buildV0(forge, repo, service);
  if (service === 'upload') entry.upload = built;
  else entry.receive = built;
  advertCache.set(repo.id, entry);
  return built;
}

function buildV0(forge: Forge, repo: Repo, service: 'upload' | 'receive'): Buffer {
  const symref = `refs/heads/${repo.defaultBranch}`;
  const caps = service === 'upload' ? UPLOAD_CAPS(symref) : RECEIVE_CAPS(symref);
  const serviceName = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [pkt(`# service=${serviceName}\n`), FLUSH];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  let first = true;
  const line = (oid: string, name: string): Buffer => {
    const text = first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`;
    first = false;
    return pkt(text);
  };
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    if (headOid) parts.push(line(headOid, 'HEAD'));
    for (const [name, oid] of refs) {
      parts.push(line(oid, name));
      if (name.startsWith('refs/tags/')) {
        const peeled = peel(forge.objects, oid);
        const obj = forge.objects.get(oid);
        if (peeled && obj && obj.t === T_TAG) {
          parts.push(pkt(`${peeled.oid} ${name}^{}\n`));
        }
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
  refAttrs: boolean;
}

const lsRefsCache = new Map<string, Buffer>();
const LSREFS_CACHE_MAX = 512;

export function lsRefsResponse(forge: Forge, repo: Repo, args: LsRefsArgs): Buffer {
  const key = `${repo.id}:${repo.gen}:${args.peel ? 1 : 0}:${args.symrefs ? 1 : 0}:${args.unborn ? 1 : 0}:${args.prefixes.join('\n')}`;
  const hit = lsRefsCache.get(key);
  if (hit) return hit;
  const lines: string[] = [];
  const target = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(target);
  const matchesPrefix = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (matchesPrefix('HEAD')) {
    if (headOid) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${target}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD symref-target:${target}`);
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!matchesPrefix(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel && name.startsWith('refs/tags/')) {
      const obj = forge.objects.get(oid);
      if (obj && obj.t === T_TAG) {
        const peeled = peel(forge.objects, oid);
        if (peeled) line += ` peeled:${peeled.oid}`;
      }
    }
    lines.push(line);
  }
  const parts = lines.map((l) => pkt(l + '\n'));
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  if (lsRefsCache.size >= LSREFS_CACHE_MAX) lsRefsCache.clear();
  lsRefsCache.set(key, out);
  return out;
}

export function parseLsRefsArgs(packets: Array<{ kind: string; data: Buffer }>): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [], refAttrs: false };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = pktText(p).trimEnd();
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line === 'ref-attributes') args.refAttrs = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    // Unknown args (e.g. ref-attributes values) are ignored.
  }
  return args;
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[]; // client-held shallow boundaries
  depth: number | null; // absolute depth from wants (null = full)
  deepenSince: number | null;
  deepenNot: string[]; // oids to exclude (refs resolved at parse time)
  filter: string | null;
  thinPack: boolean;
  ofsDelta: boolean;
  noProgress: boolean;
}

interface Plan {
  send: string[]; // oids in pack order: commits, then tags, trees, blobs
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

const FETCH_CACHE_MAX = 512;
const fetchCache = new Map<string, Buffer>();

function filterAllows(filter: string | null, type: number): boolean {
  if (!filter) return true;
  if (filter === 'blob:none') return type !== T_BLOB;
  if (filter === 'tree:0') return type === T_COMMIT;
  return true;
}

// Closure of commits reachable from `roots`, stopping traversal at
// `stopAt` boundaries (the boundary commit itself is included).
function commitClosure(
  forge: Forge,
  roots: string[],
  stopAt: Set<string>,
): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    out.add(cur);
    if (stopAt.has(cur)) continue;
    const info = commitInfo(forge.objects, cur);
    if (info) for (const p of info.parents) stack.push(p);
  }
  return out;
}

export function planFetch(forge: Forge, args: FetchArgs): Plan {
  const store = forge.objects;
  // Resolve wants: peel tags for traversal, but remember explicit wants.
  const explicit = new Set<string>(args.wants);
  const wantCommits: string[] = [];
  const wantObjects: string[] = [];
  for (const w of args.wants) {
    const obj = store.get(w);
    if (!obj) continue; // caller rejects missing wants before planning
    if (obj.t === T_COMMIT) wantCommits.push(w);
    else if (obj.t === T_TAG) {
      wantObjects.push(w);
      const peeled = peel(store, w);
      if (peeled && peeled.type === T_COMMIT) wantCommits.push(peeled.oid);
      else if (peeled) wantObjects.push(peeled.oid);
    } else {
      wantObjects.push(w);
    }
  }

  // Exclusion set from deepen-not refs (resolved to oids at parse time).
  const notClosure = new Set<string>();
  for (const oid of args.deepenNot) {
    const c = forge.peelToCommit(oid);
    if (c) {
      for (const x of commitClosure(forge, [c], new Set())) notClosure.add(x);
    }
  }

  // Have-closure: everything the client already holds. Traversal stops at
  // client-declared shallow boundaries (boundary held, parents not held).
  const boundarySet = new Set(args.shallowBoundaries);
  const held = new Set<string>();
  const heldCommits = new Set<string>();
  for (const h of args.haves) {
    const c = forge.peelToCommit(h);
    if (c) {
      for (const x of commitClosure(forge, [c], boundarySet)) {
        heldCommits.add(x);
      }
      held.add(h);
    } else if (store.has(h)) {
      held.add(h);
    }
  }
  // Shallow boundaries themselves are held even when not sent as haves.
  for (const b of boundarySet) heldCommits.add(b);

  // BFS from wants with distances; apply depth / time limits.
  const dist = new Map<string, number>();
  const included = new Set<string>();
  const shallow = new Set<string>();
  const queue: string[] = [];
  for (const w of wantCommits) {
    if (!dist.has(w)) {
      dist.set(w, 0);
      queue.push(w);
    }
  }
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++]!;
    const d = dist.get(cur)!;
    if (args.depth !== null && d >= args.depth) continue;
    const info = commitInfo(store, cur);
    if (!info) continue;
    if (args.deepenSince !== null && info.committerTime < args.deepenSince) continue;
    if (notClosure.has(cur)) continue;
    included.add(cur);
    for (const p of info.parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  // Shallow lines: included commits with a parent cut by depth/time/not.
  for (const c of included) {
    const info = commitInfo(store, c);
    if (!info) continue;
    for (const p of info.parents) {
      if (included.has(p)) continue;
      // Parent cut: depth limit, time limit, or deepen-not exclusion.
      const pd = dist.get(p);
      const depthCut = args.depth !== null && pd !== undefined && pd >= args.depth;
      const pInfo = commitInfo(store, p);
      const timeCut = args.deepenSince !== null && pInfo !== null && pInfo.committerTime < args.deepenSince;
      const notCut = notClosure.has(p);
      if (depthCut || timeCut || notCut) shallow.add(c);
      // Parents excluded only because the client holds them are NOT shallow.
    }
  }
  // Unshallow: previous boundaries now fully included (all parents included).
  const unshallow: string[] = [];
  for (const b of boundarySet) {
    if (!included.has(b)) continue;
    const info = commitInfo(store, b);
    if (!info) continue;
    if (info.parents.length === 0) continue;
    if (info.parents.every((p) => included.has(p))) unshallow.push(b);
  }

  // Commits to send: included minus held (explicit commit wants that are
  // held are NOT sent: fetch-nothing-new must deliver 0 objects).
  const sendCommits = new Set<string>();
  for (const c of included) {
    if (!heldCommits.has(c)) sendCommits.add(c);
  }

  // Trees + blobs reachable from sent commits (respecting the filter),
  // minus anything reachable from held commits.
  const send = new Set<string>();
  const sendTrees = new Set<string>();
  const sendBlobs = new Set<string>();
  const wantTreesAndBlobs = new Set<string>();
  // Explicit blob/tree wants bypass BOTH the have-closure and the filter
  // (partial-clone lazy fetch depends on this): force-include them.
  const explicitNonCommit = new Set<string>();
  for (const w of wantObjects) {
    const obj = store.get(w);
    if (!obj) continue;
    if (obj.t === T_TAG) {
      send.add(w); // explicit tag objects are always sent
    } else if (obj.t === T_TREE) {
      wantTreesAndBlobs.add(w);
      explicitNonCommit.add(w);
    } else if (obj.t === T_BLOB) {
      sendBlobs.add(w);
      explicitNonCommit.add(w);
    }
  }

  // Trees/blobs held by the client: closure under held commits.
  const heldObjects = new Set<string>();
  const collectTree = (treeOid: string, into: Set<string>, blobs: Set<string>): void => {
    const stack = [treeOid];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (seen.has(t)) continue;
      seen.add(t);
      into.add(t);
      const entries = parseTree(t, store.get(t)!.d);
      for (const e of entries) {
        const o = store.get(e.oid);
        if (!o) continue;
        if (o.t === T_TREE) stack.push(e.oid);
        else blobs.add(e.oid);
      }
    }
  };
  if (filterAllows(args.filter, T_TREE) || filterAllows(args.filter, T_BLOB)) {
    const heldTrees = new Set<string>();
    const heldBlobs = new Set<string>();
    for (const c of heldCommits) {
      const info = commitInfo(store, c);
      if (info) collectTree(info.tree, heldTrees, heldBlobs);
    }
    for (const t of heldTrees) heldObjects.add(t);
    for (const b of heldBlobs) heldObjects.add(b);
  }

  for (const c of sendCommits) {
    send.add(c);
    const info = commitInfo(store, c);
    if (!info) continue;
    if (filterAllows(args.filter, T_TREE)) {
      collectTree(info.tree, sendTrees, sendBlobs);
    }
  }
  for (const t of wantTreesAndBlobs) {
    if (filterAllows(args.filter, T_TREE)) collectTree(t, sendTrees, sendBlobs);
  }
  // Apply filter + held exclusion to trees/blobs.
  for (const t of sendTrees) {
    if (filterAllows(args.filter, T_TREE) && !heldObjects.has(t)) send.add(t);
  }
  for (const b of sendBlobs) {
    if (filterAllows(args.filter, T_BLOB) && !heldObjects.has(b)) send.add(b);
  }
  // Explicit blob/tree wants bypass the held exclusion and the filter.
  for (const w of explicitNonCommit) send.add(w);

  // ACKs: haves that exist and are ancestors of some want.
  const acks: string[] = [];
  for (const h of args.haves) {
    const c = forge.peelToCommit(h);
    if (!c) continue;
    if (!store.has(h)) continue;
    let common = false;
    for (const w of wantCommits) {
      if (forge.isAncestor(c, w)) {
        common = true;
        break;
      }
    }
    if (common) acks.push(h);
  }

  // Pack order: commits (by depth, deepest last? any order works), then
  // tags, trees, blobs. Deterministic: sort by (type, oid) within groups
  // except commits keep BFS discovery order for stability.
  const commits: string[] = [];
  const tags: string[] = [];
  const trees: string[] = [];
  const blobs: string[] = [];
  for (const oid of send) {
    const o = store.get(oid);
    if (!o) continue;
    if (o.t === T_COMMIT) commits.push(oid);
    else if (o.t === T_TAG) tags.push(oid);
    else if (o.t === T_TREE) trees.push(oid);
    else blobs.push(oid);
  }
  tags.sort();
  trees.sort();
  blobs.sort();
  const ordered = [...commits, ...tags, ...trees, ...blobs];

  return {
    send: ordered,
    shallow: [...shallow].sort(),
    unshallow: unshallow.sort(),
    acks,
  };
}

// ---------------------------------------------------------------------------
// Fetch response construction (v2 + v0)
// ---------------------------------------------------------------------------

function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
    const frame = Buffer.concat([Buffer.from([1]), slice]);
    out.push(pkt(frame));
  }
  if (data.length === 0) {
    // Never happens for packs (empty pack is 32 bytes), but stay safe.
    out.push(pkt(Buffer.from([1])));
  }
  return out;
}

export function fetchResponseV2(forge: Forge, repo: Repo, args: FetchArgs): Buffer {
  const key = [
    repo.id,
    repo.gen,
    args.wants.join(','),
    args.haves.join(','),
    args.shallowBoundaries.join(','),
    args.depth ?? '',
    args.deepenSince ?? '',
    args.deepenNot.join(','),
    args.filter ?? '',
  ].join('|');
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const plan = planFetch(forge, args);
  const pack = buildPack(forge.objects, plan.send);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pkt('acknowledgments\n'));
    if (plan.acks.length === 0) parts.push(pkt('NAK\n'));
    else for (const a of plan.acks) parts.push(pkt(`ACK ${a}\n`));
    parts.push(pkt('ready\n'));
    parts.push(DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  if (fetchCache.size >= FETCH_CACHE_MAX) fetchCache.clear();
  fetchCache.set(key, out);
  return out;
}

export function fetchResponseV0(forge: Forge, args: FetchArgs): Buffer {
  const plan = planFetch(forge, args);
  const pack = buildPack(forge.objects, plan.send);
  const parts: Buffer[] = [];
  for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const u of plan.unshallow) parts.push(pkt(`unshallow ${u}\n`));
  if (args.haves.length > 0) {
    if (plan.acks.length === 0) parts.push(pkt('NAK\n'));
    else parts.push(pkt(`ACK ${plan.acks[0]}\n`));
  } else {
    parts.push(pkt('NAK\n'));
  }
  for (const p of sidebandPackets(pack)) parts.push(p);
  // Bare flush terminates the sideband stream (real git requires it).
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// Parse a v2 fetch request body (packets after `command=fetch`).
export function parseFetchArgsV2(
  packets: Array<{ kind: string; data: Buffer }>,
  forge: Forge,
  repo: Repo,
): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallowBoundaries: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    thinPack: false,
    ofsDelta: false,
    noProgress: false,
  };
  let deepenRelative: number | null = null;
  let deepenRelativeFlag = false;
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = pktText(p).trimEnd();
    if (!seenDelim) {
      // Command section: command=fetch, agent=, object-format=
      continue;
    }
    if (line === 'done') continue;
    if (line === 'thin-pack') args.thinPack = true;
    else if (line === 'no-progress') args.noProgress = true;
    else if (line === 'ofs-delta') args.ofsDelta = true;
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13).trim(), 10);
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) {
      const ref = line.slice(11).trim();
      const oid = forge.resolveRef(repo, ref);
      if (oid) args.deepenNot.push(oid);
    } else if (line === 'deepen-relative') {
      // Real git sends this as a bare flag alongside a separate
      // `deepen N` line: the deepen value is relative to the current
      // shallow boundary rather than absolute from the wants.
      deepenRelativeFlag = true;
    } else if (line.startsWith('deepen-relative ')) {
      const n = Number.parseInt(line.slice(16).trim(), 10);
      if (Number.isFinite(n)) deepenRelative = n;
    }
    // Unknown args (want-ref, packfile-uris, etc.) are ignored.
  }
  if (deepenRelativeFlag && args.depth !== null) {
    deepenRelative = args.depth;
  }
  if (deepenRelative !== null) {
    // New depth = distance from the nearest want to the deepest shallow
    // boundary, plus 1 (the boundary generation itself), plus N.
    let base = 0;
    for (const b of args.shallowBoundaries) {
      for (const w of args.wants) {
        const d = distanceBetween(forge, w, b);
        if (d !== null && d + 1 > base) base = d + 1;
      }
    }
    args.depth = base + deepenRelative;
  }
  return args;
}

function distanceBetween(forge: Forge, from: string, to: string): number | null {
  // BFS distance from `from` down to `to` following parents.
  const start = forge.peelToCommit(from);
  const target = forge.peelToCommit(to);
  if (!start || !target) return null;
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++]!;
    const d = dist.get(cur)!;
    if (cur === target) return d;
    const info = commitInfo(forge.objects, cur);
    if (!info) continue;
    for (const p of info.parents) {
      if (!dist.has(p)) {
        dist.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  return null;
}

// Parse a v0 upload-pack request: want lines, shallow/deepen lines, flush,
// have lines, done, flush.
export function parseFetchArgsV0(packets: Array<{ kind: string; data: Buffer }>): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallowBoundaries: [],
    depth: null,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    thinPack: false,
    ofsDelta: false,
    noProgress: false,
  };
  let seenFlush = false;
  let first = true;
  for (const p of packets) {
    if (p.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    let line = pktText(p).trimEnd();
    if (first) {
      // First want line may carry " <oid> <ref>\0caps".
      const nul = line.indexOf('\0');
      if (nul !== -1) line = line.slice(0, nul);
      first = false;
    }
    if (!seenFlush) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]!);
      else if (line.startsWith('shallow ')) args.shallowBoundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) args.depth = n;
      }
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  unpackOk: boolean;
  unpackDetail: string;
  results: Array<{ ref: string; ok: boolean; reason: string }>;
}

function isValidRefName(ref: string): boolean {
  if (!ref.startsWith('refs/')) return false;
  if (ref.length > 255) return false;
  if (/[\s~^:?*\[\]\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) return false;
  if (ref.includes('@{')) return false;
  return true;
}

export function applyPush(
  forge: Forge,
  repo: Repo,
  commands: PushCommand[],
  pack: Buffer | null,
): PushResult {
  // 1. Unpack the pack (if any). New objects are stored only after the
  // whole pack parses and its closure validates.
  let newOids: string[] = [];
  if (pack && pack.length > 0) {
    let objects: GitObject[];
    try {
      objects = readPack(pack, (oid) => forge.objects.get(oid));
    } catch (e) {
      const detail = e instanceof PackError ? e.message : 'pack parse failed';
      return {
        unpackOk: false,
        unpackDetail: detail,
        results: commands.map((c) => ({ ref: c.ref, ok: false, reason: detail })),
      };
    }
    const staged = new Map<string, GitObject>();
    for (const o of objects) {
      const oid = hashObject(o.t, o.d);
      if (!forge.objects.has(oid)) staged.set(oid, o);
    }
    // Temporarily install staged objects for closure validation.
    for (const [oid, o] of staged) forge.objects.set(oid, o);
    const problem = forge.validateClosure(staged.keys());
    if (problem) {
      for (const oid of staged.keys()) forge.objects.delete(oid);
      return {
        unpackOk: false,
        unpackDetail: problem,
        results: commands.map((c) => ({ ref: c.ref, ok: false, reason: problem })),
      };
    }
    newOids = [...staged.keys()];
    void newOids;
  }

  // 2. Every new tip must exist now (connectivity check).
  for (const c of commands) {
    if (c.newOid !== ZERO_OID && !forge.objects.has(c.newOid)) {
      const detail = `object ${c.newOid} is missing`;
      return {
        unpackOk: false,
        unpackDetail: detail,
        results: commands.map((x) => ({ ref: x.ref, ok: false, reason: detail })),
      };
    }
  }

  // 3. Apply commands sequentially.
  const results: PushResult['results'] = [];
  let changed = false;
  for (const c of commands) {
    if (!isValidRefName(c.ref)) {
      results.push({ ref: c.ref, ok: false, reason: 'invalid ref' });
      continue;
    }
    const current = repo.refs.get(c.ref);
    if (c.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: c.ref, ok: false, reason: 'ref does not exist' });
      } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
        results.push({ ref: c.ref, ok: false, reason: 'stale ref' });
      } else {
        repo.refs.delete(c.ref);
        changed = true;
        results.push({ ref: c.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      // Create.
      if (c.oldOid !== ZERO_OID) {
        results.push({ ref: c.ref, ok: false, reason: 'stale ref' });
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      changed = true;
      results.push({ ref: c.ref, ok: true, reason: '' });
      continue;
    }
    if (c.oldOid !== current) {
      results.push({ ref: c.ref, ok: false, reason: 'stale ref' });
      continue;
    }
    if (c.newOid === current) {
      results.push({ ref: c.ref, ok: true, reason: '' });
      continue;
    }
    if (c.ref.startsWith('refs/tags/')) {
      // Tags are immutable: only same-oid updates pass.
      results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (forge.isAncestor(current, c.newOid)) {
      repo.refs.set(c.ref, c.newOid);
      changed = true;
      results.push({ ref: c.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  if (changed) repo.gen++;
  return { unpackOk: true, unpackDetail: 'ok', results };
}

export function pushReport(result: PushResult, sideband: boolean): Buffer {
  const lines: Buffer[] = [];
  lines.push(pkt(result.unpackOk ? 'unpack ok\n' : `unpack ${result.unpackDetail}\n`));
  for (const r of result.results) {
    lines.push(r.ok ? pkt(`ok ${r.ref}\n`) : pkt(`ng ${r.ref} ${r.reason}\n`));
  }
  if (!sideband) {
    lines.push(FLUSH);
    return Buffer.concat(lines);
  }
  // Sideband framing needs TWO flushes: one INSIDE the band-1 data
  // (terminating the report pkt-line stream the report reader parses),
  // and one bare flush terminating the outer sideband packet stream
  // (the demultiplexer reads until it). Omitting either one makes real
  // git report a disconnect.
  lines.push(FLUSH);
  const out: Buffer[] = [];
  for (const l of lines) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), l])));
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}

// Parse a receive-pack request body into commands + pack bytes.
export function parsePushRequest(body: Buffer): { commands: PushCommand[]; caps: Set<string>; pack: Buffer | null } {
  const { packets, offset } = parsePackets(body, true);
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  let first = true;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = pktText(p).trimEnd();
    if (first) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        const capStr = line.slice(nul + 1);
        for (const c of capStr.trim().split(/\s+/)) if (c) caps.add(c);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!m) throw new PktError(`bad push command: ${line}`);
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, caps, pack };
}

export function hasSideband(caps: Set<string>): boolean {
  return caps.has('side-band-64k');
}

export { isHexOid };
