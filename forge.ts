// Domain store: repos, refs, issues, pull requests, labels, comments.
// Built on the global content-addressed object store in objects.ts.
// All server-emitted timestamps use one fixed epoch so trial replays are
// byte-identical: no Date.now / Math.random anywhere in served data.

import {
  EMPTY_TREE_OID,
  T_BLOB,
  T_COMMIT,
  T_TAG,
  T_TREE,
  buildCommit,
  buildTreeFromMap,
  commitInfo,
  flattenTree,
  isHexOid,
  parseTag,
  parseTree,
  peel,
  putObject,
  type FlatEntry,
  type GitObject,
  type ObjectStore,
  type TreeEntry,
} from './objects.ts';

export const EPOCH_SEC = Number(process.env.FORGE_EPOCH_SEC ?? '1735689600');
export const EPOCH_ISO = new Date(EPOCH_SEC * 1000).toISOString();

export const VIEWER_LOGIN = process.env.FORGE_VIEWER_LOGIN ?? 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = process.env.FORGE_VIEWER_NAME ?? 'ada iversen';
export const VIEWER_EMAIL = process.env.FORGE_VIEWER_EMAIL ?? `${VIEWER_LOGIN}@example.invalid`;

export function viewerIdentityLine(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${EPOCH_SEC} +0000`;
}

// ---------------------------------------------------------------------------
// Global ids: opaque, stable, never equal to the plain numeric id.
// ---------------------------------------------------------------------------

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function repoNodeId(id: number): string {
  return b64url(`R:${id}`);
}
export function issueNodeId(repoId: number, number: number): string {
  return b64url(`I:${repoId}:${number}`);
}
export function pullNodeId(repoId: number, number: number): string {
  return b64url(`P:${repoId}:${number}`);
}
export function commentNodeId(id: number): string {
  return b64url(`C:${id}`);
}

export type DecodedId =
  | { kind: 'repo'; id: number }
  | { kind: 'issue'; repoId: number; number: number }
  | { kind: 'pull'; repoId: number; number: number }
  | { kind: 'comment'; id: number }
  | null;

export function decodeNodeId(id: string): DecodedId {
  try {
    const s = Buffer.from(id, 'base64url').toString('utf8');
    const parts = s.split(':');
    if (parts[0] === 'R' && parts.length === 2) return { kind: 'repo', id: Number(parts[1]) };
    if (parts[0] === 'I' && parts.length === 3) {
      return { kind: 'issue', repoId: Number(parts[1]), number: Number(parts[2]) };
    }
    if (parts[0] === 'P' && parts.length === 3) {
      return { kind: 'pull', repoId: Number(parts[1]), number: Number(parts[2]) };
    }
    if (parts[0] === 'C' && parts.length === 2) return { kind: 'comment', id: Number(parts[1]) };
  } catch {
    // fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  nodeId: string;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  updatedSeq: number;
  comments: Comment[];
  closedAt: string | null;
  // Cached serialized REST body; cleared on any mutation of this issue.
  cached: Buffer | null;
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeSha: string | null;
  mergedAt: string | null;
  head: string; // branch name
  base: string; // branch name
  seq: number;
  updatedSeq: number;
  comments: Comment[];
  // Cached mergeability keyed by the two live tips it was computed from.
  mergeCache: { headTip: string; baseTip: string; mergeable: boolean } | null;
}

export interface Repo {
  id: number;
  nodeId: string;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  // Generation: bumped whenever refs change. Git caches (advertisements,
  // ls-refs, fetch plans) are keyed by it, so invalidation is exact.
  gen: number;
  // Metadata version: bumped on PATCH repo (description/private/default).
  metaVer: number;
  seq: number;
  counter: number; // shared issue/PR numbering, starts at 1
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  // Cached serialized REST repo body; cleared on metadata change.
  cachedRepo: Buffer | null;
}

export class DomainError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Forge
// ---------------------------------------------------------------------------

export class Forge {
  objects: ObjectStore = new Map<string, GitObject>();
  reposByName = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  nextRepoId = 1;
  nextObjectId = 1; // global counter for issue/PR/comment/label numeric ids
  nextSeq = 1;
  // Commit depth (longest path to a root), memoized; commits are immutable.
  depthCache = new Map<string, number>();

  constructor() {
    // The empty tree always exists.
    putObject(this.objects, T_TREE, Buffer.alloc(0));
  }

  // -- repos ---------------------------------------------------------------

  createRepo(name: string, description: string, priv: boolean, defaultBranch: string): Repo {
    if (this.reposByName.has(name)) {
      throw new DomainError(422, `name already exists on this account`);
    }
    const id = this.nextRepoId++;
    const repo: Repo = {
      id,
      nodeId: repoNodeId(id),
      name,
      description,
      priv,
      defaultBranch: defaultBranch || 'main',
      refs: new Map(),
      gen: 0,
      metaVer: 0,
      seq: this.nextSeq++,
      counter: 0,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      cachedRepo: null,
    };
    this.reposByName.set(name, repo);
    this.reposById.set(id, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.reposByName.get(name);
  }

  deleteRepo(name: string): boolean {
    const repo = this.reposByName.get(name);
    if (!repo) return false;
    this.reposByName.delete(name);
    this.reposById.delete(repo.id);
    return true;
  }

  listRepos(): Repo[] {
    return [...this.reposByName.values()].sort((a, b) => a.seq - b.seq);
  }

  // -- refs ----------------------------------------------------------------

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headOid(repo: Repo): string | undefined {
    return repo.refs.get(this.headTarget(repo));
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.gen++;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const ok = repo.refs.delete(ref);
    if (ok) repo.gen++;
    return ok;
  }

  // Resolve a ref-ish: full ref, branch/tag short name, HEAD, or oid.
  resolveRef(repo: Repo, name: string): string | null {
    if (!name) return null;
    if (name === 'HEAD') return this.headOid(repo) ?? null;
    const direct = repo.refs.get(name);
    if (direct) return direct;
    const asHead = repo.refs.get(`refs/heads/${name}`);
    if (asHead) return asHead;
    const asTag = repo.refs.get(`refs/tags/${name}`);
    if (asTag) return asTag;
    if (isHexOid(name) && this.objects.has(name)) return name;
    // Abbreviated oid: unique prefix match (rare; linear scan is fine).
    if (/^[0-9a-f]{4,39}$/.test(name)) {
      let found: string | null = null;
      for (const oid of this.objects.keys()) {
        if (oid.startsWith(name)) {
          if (found) return null; // ambiguous
          found = oid;
        }
      }
      if (found) return found;
    }
    return null;
  }

  // Peel tags to the underlying commit (or null if not a commit).
  peelToCommit(oid: string): string | null {
    const p = peel(this.objects, oid);
    if (!p || p.type !== T_COMMIT) return null;
    return p.oid;
  }

  commitDepth(oid: string): number {
    const hit = this.depthCache.get(oid);
    if (hit !== undefined) return hit;
    // Iterative post-order over parents.
    const stack: Array<{ oid: string; expanded: boolean }> = [{ oid, expanded: false }];
    const local = new Map<string, number>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const cached = this.depthCache.get(cur.oid) ?? local.get(cur.oid);
      if (cached !== undefined) continue;
      const info = commitInfo(this.objects, cur.oid);
      if (!info) {
        local.set(cur.oid, 0);
        continue;
      }
      if (!cur.expanded) {
        stack.push({ oid: cur.oid, expanded: true });
        for (const p of info.parents) {
          if (this.depthCache.get(p) === undefined && local.get(p) === undefined) {
            stack.push({ oid: p, expanded: false });
          }
        }
      } else {
        let d = 0;
        for (const p of info.parents) {
          const pd = this.depthCache.get(p) ?? local.get(p) ?? 0;
          if (pd + 1 > d) d = pd + 1;
        }
        local.set(cur.oid, d);
      }
    }
    for (const [k, v] of local) this.depthCache.set(k, v);
    return this.depthCache.get(oid) ?? 0;
  }

  // Is `anc` an ancestor of `desc` (or equal)? Depth-pruned walk.
  isAncestor(anc: string, desc: string): boolean {
    const a = this.peelToCommit(anc);
    const d = this.peelToCommit(desc);
    if (!a || !d) return anc === desc;
    if (a === d) return true;
    const minDepth = this.commitDepth(a);
    const stack: string[] = [d];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === a) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (this.commitDepth(cur) <= minDepth) continue; // cannot reach anc below
      const info = commitInfo(this.objects, cur);
      if (!info) continue;
      for (const p of info.parents) {
        if (!seen.has(p)) stack.push(p);
      }
    }
    return false;
  }

  // Best common ancestor: walk both histories, return the common commit of
  // greatest depth. Linear histories (the common case) resolve fast.
  mergeBase(a: string, b: string): string | null {
    const ac = this.peelToCommit(a);
    const bc = this.peelToCommit(b);
    if (!ac || !bc) return null;
    if (ac === bc) return ac;
    // Collect all ancestors of a.
    const ancestorsA = new Set<string>();
    const stack: string[] = [ac];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (ancestorsA.has(cur)) continue;
      ancestorsA.add(cur);
      const info = commitInfo(this.objects, cur);
      if (info) for (const p of info.parents) stack.push(p);
    }
    // Walk b's ancestors deepest-first; first hit is the best base.
    const seen = new Set<string>();
    const work: string[] = [bc];
    let best: string | null = null;
    let bestDepth = -1;
    while (work.length > 0) {
      // Pop the deepest candidate.
      let bi = 0;
      for (let i = 1; i < work.length; i++) {
        if (this.commitDepth(work[i]!) > this.commitDepth(work[bi]!)) bi = i;
      }
      const cur = work.splice(bi, 1)[0]!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (ancestorsA.has(cur)) {
        const d = this.commitDepth(cur);
        if (d > bestDepth) {
          bestDepth = d;
          best = cur;
        }
        // Do not expand past a common ancestor: anything deeper through it
        // is shallower than it.
        continue;
      }
      const info = commitInfo(this.objects, cur);
      if (info) for (const p of info.parents) if (!seen.has(p)) work.push(p);
    }
    return best;
  }

  // All ancestors of a commit (including itself), as a set.
  ancestorSet(oid: string): Set<string> {
    const out = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      const info = commitInfo(this.objects, cur);
      if (info) for (const p of info.parents) stack.push(p);
    }
    return out;
  }

  // -- object validation -----------------------------------------------------

  // Validate that every reference from `oids` resolves inside the store.
  // Only newly arrived objects need checking; existing objects were valid
  // when they arrived.
  validateClosure(oids: Iterable<string>): string | null {
    for (const oid of oids) {
      const obj = this.objects.get(oid);
      if (!obj) return `object ${oid} is missing`;
      if (obj.t === T_COMMIT) {
        const info = commitInfo(this.objects, oid)!;
        if (!this.objects.has(info.tree)) return `tree ${info.tree} is missing`;
        for (const p of info.parents) {
          if (!this.objects.has(p)) return `parent ${p} is missing`;
        }
      } else if (obj.t === T_TREE) {
        let entries: TreeEntry[];
        try {
          entries = parseTree(oid, obj.d);
        } catch {
          return `tree ${oid} is malformed`;
        }
        for (const e of entries) {
          if (!this.objects.has(e.oid)) return `object ${e.oid} is missing`;
        }
      } else if (obj.t === T_TAG) {
        const tag = parseTag(oid, obj.d);
        if (!this.objects.has(tag.object)) return `object ${tag.object} is missing`;
      }
    }
    return null;
  }

  // -- server-side commits ---------------------------------------------------

  makeCommit(tree: string, parents: string[], message: string): string {
    return buildCommit(this.objects, tree, parents, viewerIdentityLine(), viewerIdentityLine(), message);
  }

  // -- contents --------------------------------------------------------------

  // Commit a file add/update/delete on a branch. Creates the branch from the
  // default branch tip when it does not exist yet.
  commitFileChange(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
    expectedSha: string | undefined,
  ): { commitSha: string; blobSha: string | null } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined) {
      // New branch: start from the default branch tip (or unborn).
      tip = this.headOid(repo);
      if (tip !== undefined && branch === repo.defaultBranch) {
        // default branch itself missing but headOid reads it; unreachable
      }
    }
    const baseTree = tip ? (commitInfo(this.objects, this.peelToCommit(tip) ?? tip)?.tree ?? EMPTY_TREE_OID) : EMPTY_TREE_OID;
    const flat = new Map(flattenTree(this.objects, baseTree));
    const existing = flat.get(path);
    if (expectedSha !== undefined && content !== null && existing && existing.oid !== expectedSha) {
      throw new DomainError(409, 'sha does not match the current file');
    }
    if (expectedSha !== undefined && content === null) {
      // DELETE: sha mismatch is a conflict.
      if (!existing || existing.oid !== expectedSha) {
        throw new DomainError(409, 'sha does not match the current file');
      }
    }
    let blobSha: string | null = null;
    if (content !== null) {
      blobSha = putObject(this.objects, T_BLOB, content);
      flat.set(path, { oid: blobSha, mode: existing?.mode ?? '100644' });
    } else {
      if (!existing) throw new DomainError(404, 'file does not exist');
      flat.delete(path);
    }
    const newTree = buildTreeFromMap(this.objects, flat);
    const parents = tip ? [this.peelToCommit(tip) ?? tip] : [];
    const commitSha = this.makeCommit(newTree, parents, message);
    repo.refs.set(ref, commitSha);
    repo.gen++;
    return { commitSha, blobSha };
  }

  // -- labels / issues -------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string, description: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: this.nextObjectId++, name, color, description };
    repo.labels.set(name, label);
    return label;
  }

  validateLabels(repo: Repo, names: string[]): void {
    for (const n of names) {
      if (!repo.labels.has(n)) throw new DomainError(422, `Invalid label: ${n}`);
    }
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    this.validateLabels(repo, labelNames);
    const number = ++repo.counter;
    const issue: Issue = {
      id: this.nextObjectId++,
      nodeId: issueNodeId(repo.id, number),
      number,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      seq: this.nextSeq++,
      updatedSeq: this.nextSeq++,
      comments: [],
      closedAt: null,
      cached: null,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  patchIssue(
    repo: Repo,
    number: number,
    patch: { title?: string; body?: string; state?: string; labels?: string[] },
  ): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new DomainError(404, 'issue not found');
    if (patch.labels !== undefined) this.validateLabels(repo, patch.labels);
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.state !== undefined) {
      if (patch.state !== 'open' && patch.state !== 'closed') {
        throw new DomainError(422, 'state must be open or closed');
      }
      issue.state = patch.state;
      issue.closedAt = patch.state === 'closed' ? EPOCH_ISO : null;
    }
    if (patch.labels !== undefined) issue.labels = [...patch.labels];
    issue.updatedSeq = this.nextSeq++;
    issue.cached = null;
    return issue;
  }

  addIssueComment(repo: Repo, number: number, body: string): Comment {
    const issue = repo.issues.get(number);
    if (!issue) throw new DomainError(404, 'issue not found');
    const id = this.nextObjectId++;
    const comment: Comment = {
      id,
      nodeId: commentNodeId(id),
      body,
      seq: this.nextSeq++,
    };
    issue.comments.push(comment);
    issue.updatedSeq = this.nextSeq++;
    issue.cached = null;
    return comment;
  }

  // -- pull requests -----------------------------------------------------------

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull {
    const headTip = this.resolveRef(repo, head);
    const baseTip = this.resolveRef(repo, base);
    if (!headTip) throw new DomainError(422, `head branch '${head}' not found`);
    if (!baseTip) throw new DomainError(422, `base branch '${base}' not found`);
    const number = ++repo.counter;
    const pull: Pull = {
      id: this.nextObjectId++,
      nodeId: pullNodeId(repo.id, number),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergeSha: null,
      mergedAt: null,
      head,
      base,
      seq: this.nextSeq++,
      updatedSeq: this.nextSeq++,
      comments: [],
      mergeCache: null,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  pullTips(repo: Repo, pull: Pull): { headTip: string | null; baseTip: string | null } {
    return {
      headTip: this.resolveRef(repo, pull.head),
      baseTip: this.resolveRef(repo, pull.base),
    };
  }

  // Flattened tree at a commit (peeling tags). Null when unresolvable.
  treeMapAt(oid: string | null): Map<string, FlatEntry> | null {
    if (!oid) return null;
    const commit = this.peelToCommit(oid);
    if (!commit) return null;
    const info = commitInfo(this.objects, commit);
    if (!info) return null;
    return flattenTree(this.objects, info.tree);
  }

  pullBaseMap(repo: Repo, pull: Pull): Map<string, FlatEntry> {
    const { headTip, baseTip } = this.pullTips(repo, pull);
    if (!headTip || !baseTip) return new Map();
    const base = this.mergeBase(headTip, baseTip);
    if (!base) return new Map();
    return this.treeMapAt(base) ?? new Map();
  }

  pullFiles(repo: Repo, pull: Pull): Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    sha: string;
  }> {
    const baseMap = this.pullBaseMap(repo, pull);
    const { headTip } = this.pullTips(repo, pull);
    const headMap = this.treeMapAt(headTip) ?? new Map<string, FlatEntry>();
    const out: Array<{
      filename: string;
      status: 'added' | 'modified' | 'removed';
      additions: number;
      deletions: number;
      sha: string;
    }> = [];
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseMap.get(path);
      const h = headMap.get(path);
      if (b && !h) {
        out.push({
          filename: path,
          status: 'removed',
          additions: 0,
          deletions: countLines(this.objects.get(b.oid)?.d),
          sha: b.oid,
        });
      } else if (!b && h) {
        out.push({
          filename: path,
          status: 'added',
          additions: countLines(this.objects.get(h.oid)?.d),
          deletions: 0,
          sha: h.oid,
        });
      } else if (b && h && b.oid !== h.oid) {
        out.push({
          filename: path,
          status: 'modified',
          additions: countLines(this.objects.get(h.oid)?.d),
          deletions: countLines(this.objects.get(b.oid)?.d),
          sha: h.oid,
        });
      }
    }
    return out;
  }

  // Three-way merge. Returns the merged flat tree, or null on conflict.
  threeWay(
    baseMap: Map<string, FlatEntry>,
    oursMap: Map<string, FlatEntry>,
    theirsMap: Map<string, FlatEntry>,
  ): Map<string, FlatEntry> | null {
    const out = new Map<string, FlatEntry>();
    const paths = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path);
      const o = oursMap.get(path);
      const t = theirsMap.get(path);
      const bOid = b?.oid;
      const oOid = o?.oid;
      const tOid = t?.oid;
      if (oOid === tOid) {
        if (o) out.set(path, o);
      } else if (oOid === bOid) {
        if (t) out.set(path, t);
      } else if (tOid === bOid) {
        if (o) out.set(path, o);
      } else {
        return null; // both sides changed the path differently
      }
    }
    return out;
  }

  pullMergeable(repo: Repo, pull: Pull): boolean {
    const { headTip, baseTip } = this.pullTips(repo, pull);
    if (!headTip || !baseTip) return false;
    const cached = pull.mergeCache;
    if (cached && cached.headTip === headTip && cached.baseTip === baseTip) return cached.mergeable;
    const baseMap = this.pullBaseMap(repo, pull);
    const oursMap = this.treeMapAt(baseTip) ?? new Map<string, FlatEntry>();
    const theirsMap = this.treeMapAt(headTip) ?? new Map<string, FlatEntry>();
    const merged = this.threeWay(baseMap, oursMap, theirsMap);
    const mergeable = merged !== null;
    pull.mergeCache = { headTip, baseTip, mergeable };
    return mergeable;
  }

  mergePull(repo: Repo, number: number, method: string): { sha: string; pull: Pull } {
    const pull = repo.pulls.get(number);
    if (!pull) throw new DomainError(404, 'pull request not found');
    if (pull.merged) throw new DomainError(405, 'Pull request is already merged');
    if (pull.state === 'closed') throw new DomainError(405, 'Pull request is closed');
    const { headTip, baseTip } = this.pullTips(repo, pull);
    if (!headTip || !baseTip) throw new DomainError(422, 'head or base branch not found');
    const headCommit = this.peelToCommit(headTip)!;
    const baseCommit = this.peelToCommit(baseTip)!;
    const base = this.mergeBase(headCommit, baseCommit);
    if (base === headCommit) {
      throw new DomainError(405, 'No changes to merge');
    }
    const baseMap = base ? (this.treeMapAt(base) ?? new Map()) : new Map<string, FlatEntry>();
    const oursMap = this.treeMapAt(baseTip) ?? new Map<string, FlatEntry>();
    const theirsMap = this.treeMapAt(headTip) ?? new Map<string, FlatEntry>();
    const merged = this.threeWay(baseMap, oursMap, theirsMap);
    if (merged === null) throw new DomainError(405, 'Merge conflict');
    const tree = buildTreeFromMap(this.objects, merged);
    const m = method.toLowerCase();
    let parents: string[];
    let message: string;
    if (m === 'squash' || m === 'rebase') {
      parents = [baseCommit];
      message = pull.title;
    } else {
      parents = [baseCommit, headCommit];
      message = `Merge pull request #${pull.number} from ${pull.head}`;
    }
    const sha = this.makeCommit(tree, parents, message);
    const ref = `refs/heads/${pull.base}`;
    repo.refs.set(ref, sha);
    repo.gen++;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeSha = sha;
    pull.mergedAt = EPOCH_ISO;
    pull.updatedSeq = this.nextSeq++;
    pull.mergeCache = null;
    return { sha, pull };
  }
}

export function countLines(data: Buffer | undefined): number {
  if (!data || data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) n++;
  if (data[data.length - 1] !== 0x0a) n++;
  return n;
}

// Re-export helpers used by other layers.
export { EMPTY_TREE_OID, T_BLOB, T_COMMIT, T_TAG, T_TREE };
