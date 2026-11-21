// HTTP server + GitHub REST v3 API. Original implementation for v3.
//
// Performance notes:
// - GET /repos/{o}/{r}/issues/{n} has a dedicated fast path: no URL
//   parsing, no query parsing, and the response body is cached per issue
//   (invalidated on any mutation of that issue).
// - Issue creation serializes from a template string, not via object
//   construction + JSON.stringify, and reuses the same builder as GET.
// - All other routes share one generic router; correctness first there.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  EPOCH_ISO,
  Forge,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  DomainError,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './forge.ts';
import {
  T_BLOB,
  T_COMMIT,
  T_TAG,
  T_TREE,
  commitInfo,
  flattenTree,
  isHexOid,
  parseIdentity,
  parseTree,
  peel,
  putObject,
} from './objects.ts';
import {
  FLUSH,
  PktError,
  applyPush,
  fetchResponseV2,
  fetchResponseV0,
  hasSideband,
  lsRefsResponse,
  parseFetchArgsV0,
  parseFetchArgsV2,
  parseLsRefsArgs,
  parsePackets,
  parsePushRequest,
  pushReport,
  v0Advertisement,
  v2Advertisement,
} from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

const BASE_URL = process.env.FORGE_PUBLIC_URL ?? 'http://localhost';
const MAX_BODY = 64 * 1024 * 1024;

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EXPECTED_AUTH = EXPECTED_TOKEN ? `Bearer ${EXPECTED_TOKEN}` : '';

let requestCounter = 0;

function nextRequestId(): string {
  return `req-${++requestCounter}`;
}

function js(value: unknown): string {
  return JSON.stringify(value);
}

const USER_NODE_ID = Buffer.from(`U:${VIEWER_ID}`, 'utf8').toString('base64url');

export function userObject(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: USER_NODE_ID,
    avatar_url: '',
    gravatar_id: '',
    url: `${BASE_URL}/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `${BASE_URL}/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

const USER_JSON = JSON.stringify(userObject());

function labelNodeId(id: number): string {
  return Buffer.from(`L:${id}`, 'utf8').toString('base64url');
}

function labelJsonString(label: Label): string {
  return (
    `{"id":${label.id},"node_id":${js(labelNodeId(label.id))},"name":${js(label.name)},` +
    `"color":${js(label.color)},"description":${js(label.description)},"default":false}`
  );
}

export function labelObject(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: labelNodeId(label.id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `${BASE_URL}/api/v3/labels/${label.id}`,
  };
}

// Per-repo URL prefixes for issue JSON. The three URL fields share two
// prefixes, so cache them per repo instead of rebuilding them 3x per call.
// Repo names never change after creation (no rename path), but the cached
// name is re-checked on every hit so a rename would rebuild instead of
// serving a stale prefix. WeakMap so deleted repos do not leak entries.
interface IssueUrlPrefix {
  name: string;
  api: string; // `${BASE_URL}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`
  html: string; // `${BASE_URL}/${VIEWER_LOGIN}/${repo.name}`
}

const issueUrlPrefixes = new WeakMap<Repo, IssueUrlPrefix>();

function issueUrls(repo: Repo): IssueUrlPrefix {
  const cached = issueUrlPrefixes.get(repo);
  if (cached && cached.name === repo.name) return cached;
  const entry: IssueUrlPrefix = {
    name: repo.name,
    api: `${BASE_URL}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    html: `${BASE_URL}/${VIEWER_LOGIN}/${repo.name}`,
  };
  issueUrlPrefixes.set(repo, entry);
  return entry;
}

// Single canonical issue serializer, used by create + GET + lists + MCP.
export function issueJsonString(repo: Repo, issue: Issue): string {
  let labels = '';
  for (let i = 0; i < issue.labels.length; i++) {
    const label = repo.labels.get(issue.labels[i]!);
    if (!label) continue;
    if (labels) labels += ',';
    labels += labelJsonString(label);
  }
  const n = issue.number;
  const urls = issueUrls(repo);
  return (
    `{"id":${issue.id},"node_id":${js(issue.nodeId)},"number":${n},` +
    `"title":${js(issue.title)},"body":${js(issue.body)},"state":${js(issue.state)},` +
    `"user":${USER_JSON},"labels":[${labels}],"assignee":null,"assignees":[],` +
    `"locked":false,"milestone":null,"comments":${issue.comments.length},` +
    `"created_at":${js(EPOCH_ISO)},"updated_at":${js(EPOCH_ISO)},` +
    `"closed_at":${issue.closedAt ? js(issue.closedAt) : 'null'},` +
    `"url":${js(`${urls.api}/issues/${n}`)},` +
    `"html_url":${js(`${urls.html}/issues/${n}`)},` +
    `"comments_url":${js(`${urls.api}/issues/${n}/comments`)}}`
  );
}

export function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return JSON.parse(issueJsonString(repo, issue)) as Record<string, unknown>;
}

export function commentObject(repo: Repo, issueOrPull: number, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId,
    body: comment.body,
    user: userObject(),
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    url: `${BASE_URL}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${BASE_URL}/${VIEWER_LOGIN}/${repo.name}/issues/${issueOrPull}#issuecomment-${comment.id}`,
  };
}

export function repoObject(forge: Forge, repo: Repo): Record<string, unknown> {
  let openCount = 0;
  for (const i of repo.issues.values()) if (i.state === 'open') openCount++;
  for (const p of repo.pulls.values()) if (p.state === 'open') openCount++;
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    private: repo.priv,
    owner: userObject(),
    description: repo.description,
    fork: false,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    pushed_at: EPOCH_ISO,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openCount,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.priv ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    url: `${BASE_URL}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}`,
    html_url: `${BASE_URL}/${VIEWER_LOGIN}/${repo.name}`,
    clone_url: `${BASE_URL}/${VIEWER_LOGIN}/${repo.name}.git`,
  };
}

export function pullObject(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const { headTip, baseTip } = forge.pullTips(repo, pull);
  const repoRef = {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    private: repo.priv,
    owner: userObject(),
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: userObject(),
    labels: [],
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: pull.comments.length,
    created_at: EPOCH_ISO,
    updated_at: EPOCH_ISO,
    closed_at: pull.state === 'closed' ? EPOCH_ISO : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? forge.pullMergeable(repo, pull) : null,
    rebaseable: null,
    mergeable_state: pull.state === 'open' ? (forge.pullMergeable(repo, pull) ? 'clean' : 'dirty') : 'closed',
    merged_by: pull.merged ? userObject() : null,
    head: {
      label: `${VIEWER_LOGIN}:${pull.head}`,
      ref: pull.head,
      sha: headTip,
      user: userObject(),
      repo: repoRef,
    },
    base: {
      label: `${VIEWER_LOGIN}:${pull.base}`,
      ref: pull.base,
      sha: baseTip,
      user: userObject(),
      repo: repoRef,
    },
    url: `${BASE_URL}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
    html_url: `${BASE_URL}/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
  };
}

export function commitObject(forge: Forge, sha: string): Record<string, unknown> | null {
  const commitOid = forge.peelToCommit(sha);
  if (!commitOid) return null;
  const info = commitInfo(forge.objects, commitOid);
  if (!info) return null;
  const author = parseIdentity(info.author);
  const committer = parseIdentity(info.committer);
  const message = info.message.endsWith('\n') ? info.message.slice(0, -1) : info.message;
  const dateOf = (t: number): string => new Date(t * 1000).toISOString();
  return {
    sha: commitOid,
    node_id: Buffer.from(`Cmt:${commitOid}`, 'utf8').toString('base64url'),
    commit: {
      message,
      author: { name: author.name, email: author.email, date: dateOf(author.time) },
      committer: { name: committer.name, email: committer.email, date: dateOf(committer.time) },
      tree: { sha: info.tree },
      url: `${BASE_URL}/api/v3/repos/x/x/git/commits/${commitOid}`,
    },
    author: author.email === VIEWER_EMAIL ? userObject() : null,
    committer: committer.email === VIEWER_EMAIL ? userObject() : null,
    parents: info.parents.map((p) => ({ sha: p })),
    url: `${BASE_URL}/api/v3/repos/x/x/commits/${commitOid}`,
  };
}

function refObject(ref: string, oid: string, forge: Forge): Record<string, unknown> {
  const obj = forge.objects.get(oid);
  const type = obj ? ({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' })[obj.t] ?? 'commit' : 'commit';
  return {
    ref,
    node_id: Buffer.from(`Ref:${ref}:${oid}`, 'utf8').toString('base64url'),
    url: `${BASE_URL}/api/v3/repos/x/x/git/refs/${ref.replace(/^refs\//, '')}`,
    object: { sha: oid, type, url: `${BASE_URL}/api/v3/repos/x/x/git/${type}s/${oid}` },
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  extraHeaders?: Record<string, string>,
): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(buf);
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, JSON.stringify({ message }));
}

function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

function isAuthed(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (!h) return false;
  if (EXPECTED_AUTH) return h === EXPECTED_AUTH;
  return h.startsWith('Bearer ') && h.length > 7;
}

interface Query {
  get(name: string): string | undefined;
  entries(): Array<[string, string]>;
}

function parseQuery(raw: string): Query {
  const map = new Map<string, string>();
  const list: Array<[string, string]> = [];
  if (raw) {
    for (const part of raw.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = decodeURIComponentSafe(eq === -1 ? part : part.slice(0, eq));
      const v = decodeURIComponentSafe(eq === -1 ? '' : part.slice(eq + 1));
      if (!map.has(k)) map.set(k, v);
      list.push([k, v]);
    }
  }
  return {
    get: (name: string) => map.get(name),
    entries: () => list,
  };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Split a URL path into decoded segments. Decoded segments containing '/'
// (from %2F) are re-split so slashed branch names and file paths work.
function splitPath(path: string): string[] {
  const out: string[] = [];
  for (const raw of path.split('/')) {
    if (!raw) continue;
    const decoded = decodeURIComponentSafe(raw);
    if (decoded.includes('/')) {
      for (const piece of decoded.split('/')) if (piece) out.push(piece);
    } else {
      out.push(decoded);
    }
  }
  return out;
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parsePageParams(query: Query): { page: number; perPage: number } {
  let perPage = Number.parseInt(query.get('per_page') ?? '', 10);
  if (!Number.isFinite(perPage)) perPage = 30;
  perPage = Math.min(100, Math.max(1, perPage));
  let page = Number.parseInt(query.get('page') ?? '', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { page, perPage };
}

function linkHeader(
  req: IncomingMessage,
  path: string,
  query: Query,
  page: number,
  perPage: number,
  total: number,
): string | undefined {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return undefined;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const build = (p: number): string => {
    const params = new Map<string, string>();
    for (const [k, v] of query.entries()) params.set(k, v);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    const qs = [...params.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    return `<${base}?${qs}>`;
  };
  return `${build(page + 1)}; rel="next", ${build(lastPage)}; rel="last"`;
}

function paginate<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// ---------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------

function handleRest(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  path: string,
  query: Query,
  body: Buffer,
): void {
  // Root + meta + user.
  if (segments.length === 0) {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found');
    return sendJson(
      res,
      200,
      JSON.stringify({
        current_user_url: `${BASE_URL}/api/v3/user`,
        repository_url: `${BASE_URL}/api/v3/repos/{owner}/{repo}`,
        user_url: `${BASE_URL}/api/v3/users/{username}`,
      }),
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found');
    return sendJson(res, 200, JSON.stringify({ installed_version: '1.0.0' }));
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return sendErr(res, 404, 'Not Found');
    return sendJson(res, 200, JSON.stringify(userObject()));
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = forge.listRepos();
      const { page, perPage } = parsePageParams(query);
      const link = linkHeader(req, path, query, page, perPage, repos.length);
      return sendJson(
        res,
        200,
        JSON.stringify(paginate(repos, page, perPage).map((r) => repoObject(forge, r))),
        link ? { link } : undefined,
      );
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
      const input = asObject(parsed.value);
      const name = asString(input.name);
      if (!name) return sendErr(res, 422, 'name is required');
      try {
        const repo = forge.createRepo(
          name,
          asString(input.description) ?? '',
          input.private === true,
          asString(input.default_branch) ?? 'main',
        );
        return sendJson(res, 201, JSON.stringify(repoObject(forge, repo)));
      } catch (e) {
        if (e instanceof DomainError) return sendErr(res, e.status, e.message);
        throw e;
      }
    }
    return sendErr(res, 404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    return sendErr(res, 404, 'Not Found');
  }
  const owner = segments[1]!;
  const repoName = segments[2]!;
  if (owner !== VIEWER_LOGIN) return sendErr(res, 404, 'Not Found');
  const repo = forge.getRepo(repoName);
  if (!repo) return sendErr(res, 404, 'Not Found');
  const rest = segments.slice(3);

  try {
    return handleRepoRoute(forge, req, res, method, repo, rest, path, query, body);
  } catch (e) {
    if (e instanceof DomainError) return sendErr(res, e.status, e.message);
    throw e;
  }
}

function handleRepoRoute(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  repo: Repo,
  rest: string[],
  path: string,
  query: Query,
  body: Buffer,
): void {
  // Repo itself.
  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, JSON.stringify(repoObject(forge, repo)));
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return sendNoContent(res);
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
      const input = asObject(parsed.value);
      const desc = asString(input.description);
      if (desc !== undefined) repo.description = desc;
      if (typeof input.private === 'boolean') repo.priv = input.private;
      const db = asString(input.default_branch);
      if (db && repo.refs.has(`refs/heads/${db}`) && db !== repo.defaultBranch) {
        repo.defaultBranch = db;
        repo.gen++;
      }
      repo.metaVer++;
      repo.cachedRepo = null;
      return sendJson(res, 200, JSON.stringify(repoObject(forge, repo)));
    }
    return sendErr(res, 404, 'Not Found');
  }

  const head = rest[0]!;

  // Branches.
  if (head === 'branches') {
    if (rest.length === 1) {
      if (method !== 'GET') return sendErr(res, 404, 'Not Found');
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      return sendJson(
        res,
        200,
        JSON.stringify(
          branches.map((name) => ({
            name,
            commit: { sha: repo.refs.get(`refs/heads/${name}`) },
            protected: false,
          })),
        ),
      );
    }
    if (method !== 'GET') return sendErr(res, 404, 'Not Found');
    const branch = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (!sha) return sendErr(res, 404, 'Branch not found');
    return sendJson(res, 200, JSON.stringify({ name: branch, sha, commit: { sha }, protected: false }));
  }

  // Commits.
  if (head === 'commits') {
    if (rest.length === 1) {
      if (method !== 'GET') return sendErr(res, 404, 'Not Found');
      const shaParam = query.get('sha');
      let tip: string | null;
      if (shaParam) {
        tip = forge.resolveRef(repo, shaParam);
        if (!tip) return sendErr(res, 404, 'No commit found for SHA');
      } else {
        tip = forge.headOid(repo) ?? null;
      }
      if (!tip) return sendJson(res, 200, '[]');
      const start = forge.peelToCommit(tip);
      if (!start) return sendJson(res, 200, '[]');
      // DFS pre-order over all parents, first-parent first, deduped.
      const order: string[] = [];
      const seen = new Set<string>();
      const stack = [start];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        order.push(cur);
        const info = commitInfo(forge.objects, cur);
        if (info) {
          for (let i = info.parents.length - 1; i >= 0; i--) stack.push(info.parents[i]!);
        }
      }
      const { page, perPage } = parsePageParams(query);
      const link = linkHeader(req, path, query, page, perPage, order.length);
      const items = paginate(order, page, perPage)
        .map((oid) => commitObject(forge, oid))
        .filter((c): c is Record<string, unknown> => c !== null);
      return sendJson(res, 200, JSON.stringify(items), link ? { link } : undefined);
    }
    if (method !== 'GET') return sendErr(res, 404, 'Not Found');
    const sha = rest.slice(1).join('/');
    const resolved = forge.resolveRef(repo, sha);
    if (!resolved) return sendErr(res, 404, 'No commit found for SHA');
    const obj = commitObject(forge, resolved);
    if (!obj) return sendErr(res, 404, 'No commit found for SHA');
    return sendJson(res, 200, JSON.stringify(obj));
  }

  // git/refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
        return sendJson(res, 200, JSON.stringify(refs.map(([r, o]) => refObject(r, o, forge))));
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
        const input = asObject(parsed.value);
        const ref = asString(input.ref);
        const sha = asString(input.sha);
        if (!ref || !ref.startsWith('refs/')) return sendErr(res, 422, 'ref must start with refs/');
        if (!sha || !forge.objects.has(sha)) return sendErr(res, 422, 'Object does not exist');
        if (repo.refs.has(ref)) return sendErr(res, 422, 'Reference already exists');
        forge.setRef(repo, ref, sha);
        return sendJson(res, 201, JSON.stringify(refObject(ref, sha, forge)));
      }
      return sendErr(res, 404, 'Not Found');
    }
    const ref = `refs/${rest.slice(2).join('/')}`;
    if (method === 'GET') {
      const exact = repo.refs.get(ref);
      if (exact) return sendJson(res, 200, JSON.stringify(refObject(ref, exact, forge)));
      const prefixed = [...repo.refs.entries()]
        .filter(([r]) => r.startsWith(ref + '/') || r === ref)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (prefixed.length > 0) {
        return sendJson(res, 200, JSON.stringify(prefixed.map(([r, o]) => refObject(r, o, forge))));
      }
      return sendErr(res, 404, 'Reference does not exist');
    }
    if (method === 'DELETE') {
      if (!repo.refs.has(ref)) return sendErr(res, 404, 'Reference does not exist');
      forge.deleteRef(repo, ref);
      return sendNoContent(res);
    }
    return sendErr(res, 404, 'Not Found');
  }

  // Contents.
  if (head === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') return handleContentsGet(forge, res, repo, filePath, query);
    if (method === 'PUT') return handleContentsPut(forge, res, repo, filePath, body);
    if (method === 'DELETE') return handleContentsDelete(forge, res, repo, filePath, body);
    return sendErr(res, 404, 'Not Found');
  }

  // Labels.
  if (head === 'labels') {
    if (rest.length !== 1) return sendErr(res, 404, 'Not Found');
    if (method === 'GET') {
      return sendJson(res, 200, JSON.stringify([...repo.labels.values()].map(labelObject)));
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
      const input = asObject(parsed.value);
      const name = asString(input.name);
      if (!name) return sendErr(res, 422, 'name is required');
      const label = forge.createLabel(repo, name, asString(input.color) ?? 'ededed', asString(input.description) ?? '');
      return sendJson(res, 201, JSON.stringify(labelObject(label)));
    }
    return sendErr(res, 404, 'Not Found');
  }

  // Issues.
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return handleIssuesList(forge, req, res, repo, path, query);
      if (method === 'POST') return handleIssueCreate(forge, res, repo, body);
      return sendErr(res, 404, 'Not Found');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return sendErr(res, 404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return handleIssueGet(res, repo, num);
      if (method === 'PATCH') return handleIssuePatch(forge, res, repo, num, body);
      return sendErr(res, 404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        const issue = repo.issues.get(num);
        if (!issue) return sendErr(res, 404, 'Not Found');
        return sendJson(res, 200, JSON.stringify(issue.comments.map((c) => commentObject(repo, num, c))));
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
        const input = asObject(parsed.value);
        const text = asString(input.body);
        if (text === undefined) return sendErr(res, 422, 'body is required');
        const comment = forge.addIssueComment(repo, num, text);
        return sendJson(res, 201, JSON.stringify(commentObject(repo, num, comment)));
      }
      return sendErr(res, 404, 'Not Found');
    }
    return sendErr(res, 404, 'Not Found');
  }

  // Pull requests.
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.seq - a.seq);
        const { page, perPage } = parsePageParams(query);
        const link = linkHeader(req, path, query, page, perPage, pulls.length);
        return sendJson(
          res,
          200,
          JSON.stringify(paginate(pulls, page, perPage).map((p) => pullObject(forge, repo, p))),
          link ? { link } : undefined,
        );
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
        const input = asObject(parsed.value);
        const title = asString(input.title);
        const headBranch = asString(input.head);
        const baseBranch = asString(input.base);
        if (!title) return sendErr(res, 422, 'title is required');
        if (!headBranch || !baseBranch) return sendErr(res, 422, 'head and base are required');
        const pull = forge.createPull(repo, headBranch, baseBranch, title, asString(input.body) ?? '');
        return sendJson(res, 201, JSON.stringify(pullObject(forge, repo, pull)));
      }
      return sendErr(res, 404, 'Not Found');
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num) || num < 1) return sendErr(res, 404, 'Not Found');
    if (rest.length === 2) {
      if (method !== 'GET') return sendErr(res, 404, 'Not Found');
      const pull = repo.pulls.get(num);
      if (!pull) return sendErr(res, 404, 'Not Found');
      return sendJson(res, 200, JSON.stringify(pullObject(forge, repo, pull)));
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') return sendErr(res, 404, 'Not Found');
      const pull = repo.pulls.get(num);
      if (!pull) return sendErr(res, 404, 'Not Found');
      const files = forge.pullFiles(repo, pull).map((f) => ({
        sha: f.sha,
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
      }));
      return sendJson(res, 200, JSON.stringify(files));
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') return sendErr(res, 404, 'Not Found');
      const parsed = parseJsonBody(body);
      if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
      const input = asObject(parsed.value);
      const methodName = asString(input.merge_method) ?? 'merge';
      const { sha } = forge.mergePull(repo, num, methodName);
      return sendJson(res, 200, JSON.stringify({ sha, merged: true, message: 'Pull Request successfully merged' }));
    }
    return sendErr(res, 404, 'Not Found');
  }

  return sendErr(res, 404, 'Not Found');
}

function handleIssuesList(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: Query,
): void {
  void forge;
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  const keyOf = (i: Issue): number => (sort === 'updated' ? i.updatedSeq : sort === 'comments' ? i.comments.length : i.seq);
  issues.sort((a, b) => {
    const d = keyOf(a) - keyOf(b);
    if (d !== 0) return direction === 'asc' ? d : -d;
    return direction === 'asc' ? a.number - b.number : b.number - a.number;
  });
  const { page, perPage } = parsePageParams(query);
  const link = linkHeader(req, path, query, page, perPage, issues.length);
  const pageItems = paginate(issues, page, perPage);
  const body = `[${pageItems.map((i) => issueJsonString(repo, i)).join(',')}]`;
  sendJson(res, 200, body, link ? { link } : undefined);
}

function handleIssueCreate(forge: Forge, res: ServerResponse, repo: Repo, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
  const input = asObject(parsed.value);
  const title = asString(input.title);
  if (title === undefined) return sendErr(res, 422, 'title is required');
  const labelNames: string[] = [];
  if (Array.isArray(input.labels)) {
    for (const l of input.labels) {
      if (typeof l === 'string') labelNames.push(l);
      else if (l && typeof l === 'object') {
        const n = asString((l as Record<string, unknown>).name);
        if (n) labelNames.push(n);
      }
    }
  }
  const issue = forge.createIssue(repo, title, asString(input.body) ?? '', labelNames);
  sendJson(res, 201, issueJsonString(repo, issue));
}

function handleIssueGet(res: ServerResponse, repo: Repo, num: number): void {
  const issue = repo.issues.get(num);
  if (!issue) return sendErr(res, 404, 'Not Found');
  if (!issue.cached) issue.cached = Buffer.from(issueJsonString(repo, issue), 'utf8');
  sendJson(res, 200, issue.cached);
}

function handleIssuePatch(forge: Forge, res: ServerResponse, repo: Repo, num: number, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
  const input = asObject(parsed.value);
  const patch: { title?: string; body?: string; state?: string; labels?: string[] } = {};
  const title = asString(input.title);
  if (title !== undefined) patch.title = title;
  const text = asString(input.body);
  if (text !== undefined) patch.body = text;
  const state = asString(input.state);
  if (state !== undefined) patch.state = state;
  if (Array.isArray(input.labels)) {
    const names: string[] = [];
    for (const l of input.labels) {
      if (typeof l === 'string') names.push(l);
      else if (l && typeof l === 'object') {
        const n = asString((l as Record<string, unknown>).name);
        if (n) names.push(n);
      }
    }
    patch.labels = names;
  }
  const issue = forge.patchIssue(repo, num, patch);
  sendJson(res, 200, issueJsonString(repo, issue));
}

// ---------------------------------------------------------------------------
// Contents handlers
// ---------------------------------------------------------------------------

function contentsRefTip(forge: Forge, repo: Repo, query: Query): string | null {
  const ref = query.get('ref');
  if (ref) return forge.resolveRef(repo, ref);
  return forge.headOid(repo) ?? null;
}

function handleContentsGet(forge: Forge, res: ServerResponse, repo: Repo, filePath: string, query: Query): void {
  const tip = contentsRefTip(forge, repo, query);
  if (!tip) return sendErr(res, 404, 'Not Found');
  const commit = forge.peelToCommit(tip);
  if (!commit) return sendErr(res, 404, 'Not Found');
  const info = commitInfo(forge.objects, commit);
  if (!info) return sendErr(res, 404, 'Not Found');
  const flat = flattenTree(forge.objects, info.tree);
  const entry = flat.get(filePath);
  if (entry && filePath !== '') {
    const obj = forge.objects.get(entry.oid);
    const data = obj?.d ?? Buffer.alloc(0);
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    return sendJson(
      res,
      200,
      JSON.stringify({
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name,
        path: filePath,
        sha: entry.oid,
        content: data.toString('base64'),
        url: `${BASE_URL}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/contents/${filePath}`,
        html_url: `${BASE_URL}/${VIEWER_LOGIN}/${repo.name}/blob/${repo.defaultBranch}/${filePath}`,
        download_url: null,
      }),
    );
  }
  // Directory listing: immediate children of filePath ('' = root).
  const prefix = filePath === '' ? '' : filePath + '/';
  const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [p, e] of flat) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const obj = forge.objects.get(e.oid);
      children.set(rest, { type: 'file', sha: e.oid, size: obj?.d.length ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) children.set(dir, { type: 'dir', sha: '', size: 0 });
    }
  }
  if (children.size === 0) return sendErr(res, 404, 'Not Found');
  const items = [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, c]) => ({
      type: c.type,
      name,
      path: prefix + name,
      sha: c.sha,
      size: c.size,
      url: `${BASE_URL}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/contents/${prefix + name}`,
    }));
  sendJson(res, 200, JSON.stringify(items));
}

function handleContentsPut(forge: Forge, res: ServerResponse, repo: Repo, filePath: string, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
  const input = asObject(parsed.value);
  const message = asString(input.message);
  const contentB64 = asString(input.content);
  if (message === undefined) return sendErr(res, 422, 'message is required');
  if (contentB64 === undefined) return sendErr(res, 422, 'content is required');
  const branch = asString(input.branch) ?? repo.defaultBranch;
  const sha = asString(input.sha);
  const content = Buffer.from(contentB64, 'base64');
  // Create (201) vs update (200): does the file exist at the branch tip?
  let exists = false;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? forge.headOid(repo);
  if (tip) {
    const commit = forge.peelToCommit(tip);
    const info = commit ? commitInfo(forge.objects, commit) : null;
    if (info) exists = flattenTree(forge.objects, info.tree).has(filePath);
  }
  const { commitSha, blobSha } = forge.commitFileChange(repo, branch, filePath, content, message, sha);
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const commitObj = commitObject(forge, commitSha);
  sendJson(
    res,
    exists ? 200 : 201,
    JSON.stringify({
      content: {
        name,
        path: filePath,
        sha: blobSha,
        size: content.length,
        encoding: 'base64',
        content: contentB64,
        url: `${BASE_URL}/api/v3/repos/${VIEWER_LOGIN}/${repo.name}/contents/${filePath}`,
      },
      commit: commitObj,
    }),
  );
}

function handleContentsDelete(forge: Forge, res: ServerResponse, repo: Repo, filePath: string, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) return sendErr(res, 400, 'Invalid JSON');
  const input = asObject(parsed.value);
  const message = asString(input.message) ?? `Delete ${filePath}`;
  const branch = asString(input.branch) ?? repo.defaultBranch;
  const sha = asString(input.sha);
  const { commitSha } = forge.commitFileChange(repo, branch, filePath, null, message, sha);
  sendJson(res, 200, JSON.stringify({ content: null, commit: commitObject(forge, commitSha) }));
}

// ---------------------------------------------------------------------------
// Git smart-HTTP handlers
// ---------------------------------------------------------------------------

function gitRepo(forge: Forge, res: ServerResponse, owner: string, repoSegment: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    sendErr(res, 404, 'Not Found');
    return null;
  }
  if (!repoSegment.endsWith('.git')) {
    sendErr(res, 404, 'Not Found');
    return null;
  }
  const repo = forge.getRepo(repoSegment.slice(0, -4));
  if (!repo) {
    sendErr(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

function handleInfoRefs(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  query: Query,
): void {
  const service = query.get('service');
  const proto = (req.headers['git-protocol'] ?? '').toString().toLowerCase();
  if (service === 'git-upload-pack') {
    if (proto.includes('version=2')) {
      const body = v2Advertisement();
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'content-length': body.length,
        'x-github-request-id': nextRequestId(),
      });
      res.end(body);
      return;
    }
    const body = v0Advertisement(forge, repo, 'upload');
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-advertisement',
      'content-length': body.length,
      'x-github-request-id': nextRequestId(),
    });
    res.end(body);
    return;
  }
  if (service === 'git-receive-pack') {
    const body = v0Advertisement(forge, repo, 'receive');
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-advertisement',
      'content-length': body.length,
      'x-github-request-id': nextRequestId(),
    });
    res.end(body);
    return;
  }
  sendErr(res, 404, 'Not Found');
}

function handleUploadPack(forge: Forge, res: ServerResponse, repo: Repo, body: Buffer): void {
  let out: Buffer;
  try {
    const { packets } = parsePackets(body, false);
    const first = packets.find((p) => p.kind === 'data');
    const firstLine = first ? first.data.toString('utf8').trimEnd() : '';
    if (firstLine.startsWith('command=')) {
      const command = firstLine.slice('command='.length);
      const rest = packets.slice(packets.indexOf(first!));
      if (command === 'ls-refs') {
        const args = parseLsRefsArgs(rest.slice(1));
        out = lsRefsResponse(forge, repo, args);
      } else if (command === 'fetch') {
        const args = parseFetchArgsV2(rest, forge, repo);
        for (const w of args.wants) {
          if (!forge.objects.has(w)) {
            return sendErr(res, 400, `object ${w} not found`);
          }
        }
        out = fetchResponseV2(forge, repo, args);
      } else {
        return sendErr(res, 400, `unknown command ${command}`);
      }
    } else if (firstLine.startsWith('want ')) {
      const args = parseFetchArgsV0(packets);
      for (const w of args.wants) {
        if (!forge.objects.has(w)) {
          return sendErr(res, 400, `object ${w} not found`);
        }
      }
      out = fetchResponseV0(forge, args);
    } else {
      return sendErr(res, 400, 'malformed upload-pack request');
    }
  } catch (e) {
    if (e instanceof PktError) return sendErr(res, 400, e.message);
    throw e;
  }
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': out.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(out);
}

function handleReceivePack(forge: Forge, res: ServerResponse, repo: Repo, body: Buffer): void {
  let result;
  let sideband = false;
  try {
    const { commands, caps, pack } = parsePushRequest(body);
    sideband = hasSideband(caps);
    result = applyPush(forge, repo, commands, pack);
  } catch (e) {
    if (e instanceof PktError) return sendErr(res, 400, e.message);
    throw e;
  }
  const out = pushReport(result, sideband);
  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'content-length': out.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(out);
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

const FAST_ISSUE_RE = /^\/api\/v3\/repos\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/issues\/(\d+)$/;

function dispatch(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const rawUrl = req.url ?? '/';
  const qmark = rawUrl.indexOf('?');
  const pathPart = qmark === -1 ? rawUrl : rawUrl.slice(0, qmark);
  const queryPart = qmark === -1 ? '' : rawUrl.slice(qmark + 1);
  const method = (req.method ?? 'GET').toUpperCase();

  // Health check: no auth required.
  if (pathPart === '/healthz') {
    if (method === 'GET') return sendJson(res, 200, '{"ok":true}');
    return sendErr(res, 404, 'Not Found');
  }

  if (!isAuthed(req)) {
    return sendErr(res, 401, 'Requires authentication');
  }

  // Ultra-fast path: GET /api/v3/repos/{owner}/{repo}/issues/{n}.
  // Owner/repo names ([A-Za-z0-9._-]) and issue numbers never need
  // percent-decoding, so this skips path splitting and query parsing
  // entirely. Anything not matching falls through to the generic router.
  if (method === 'GET') {
    const fast = FAST_ISSUE_RE.exec(pathPart);
    if (fast) {
      if (fast[1] !== VIEWER_LOGIN) return sendErr(res, 404, 'Not Found');
      const repo = forge.getRepo(fast[2]!);
      if (!repo) return sendErr(res, 404, 'Not Found');
      const issue = repo.issues.get(Number(fast[3]!));
      if (!issue) return sendErr(res, 404, 'Not Found');
      if (!issue.cached) issue.cached = Buffer.from(issueJsonString(repo, issue), 'utf8');
      return sendJson(res, 200, issue.cached);
    }
  }

  // GraphQL.
  if (pathPart === '/api/graphql') {
    if (method !== 'POST') return sendErr(res, 404, 'Not Found');
    const { status, payload } = handleGraphQL(forge, body);
    return sendJson(res, status, JSON.stringify(payload));
  }

  // MCP.
  if (pathPart === '/mcp') {
    if (method === 'GET' || method === 'DELETE') return sendErr(res, 405, 'Method Not Allowed');
    if (method !== 'POST') return sendErr(res, 404, 'Not Found');
    const { status, payload } = handleMCP(forge, body);
    if (payload === null) {
      res.writeHead(status, { 'x-github-request-id': nextRequestId() });
      return res.end();
    }
    return sendJson(res, status, JSON.stringify(payload));
  }

  const segments = splitPath(pathPart);

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    // Fast path: GET single issue — no query parse, cached body.
    if (
      method === 'GET' &&
      segments.length === 7 &&
      segments[2] === 'repos' &&
      segments[5] === 'issues' &&
      /^\d+$/.test(segments[6]!)
    ) {
      if (segments[3] !== VIEWER_LOGIN) return sendErr(res, 404, 'Not Found');
      const repo = forge.getRepo(segments[4]!);
      if (!repo) return sendErr(res, 404, 'Not Found');
      const issue = repo.issues.get(Number(segments[6]!));
      if (!issue) return sendErr(res, 404, 'Not Found');
      if (!issue.cached) issue.cached = Buffer.from(issueJsonString(repo, issue), 'utf8');
      return sendJson(res, 200, issue.cached);
    }
    const query = parseQuery(queryPart);
    try {
      handleRest(forge, req, res, method, segments.slice(2), pathPart, query, body);
    } catch (e) {
      if (e instanceof DomainError) return sendErr(res, e.status, e.message);
      throw e;
    }
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 3 && segments[2] === 'info' && segments[3] === 'refs') {
    const repo = gitRepo(forge, res, segments[0]!, segments[1]!);
    if (!repo) return;
    if (method !== 'GET') return sendErr(res, 404, 'Not Found');
    return handleInfoRefs(forge, req, res, repo, parseQuery(queryPart));
  }
  if (segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')) {
    const repo = gitRepo(forge, res, segments[0]!, segments[1]!);
    if (!repo) return;
    if (method !== 'POST') return sendErr(res, 404, 'Not Found');
    if (segments[2] === 'git-upload-pack') return handleUploadPack(forge, res, repo, body);
    return handleReceivePack(forge, res, repo, body);
  }

  return sendErr(res, 404, 'Not Found');
}

export function createForgeServer(forge: Forge): Server {
  const server = createServer((req, res) => {
    req.on('error', () => {
      try {
        res.destroy();
      } catch {
        // ignore
      }
    });
    res.on('error', () => {
      // Client went away; nothing to do.
    });
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      try {
        dispatch(forge, req, res, Buffer.alloc(0));
      } catch (e) {
        if (!res.headersSent) {
          try {
            sendErr(res, 500, e instanceof Error ? e.message : 'internal error');
          } catch {
            // ignore
          }
        }
      }
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) {
        if (!res.headersSent) sendErr(res, 413, 'request body too large');
        return;
      }
      try {
        dispatch(forge, req, res, Buffer.concat(chunks));
      } catch (e) {
        if (!res.headersSent) {
          try {
            sendErr(res, 500, e instanceof Error ? e.message : 'internal error');
          } catch {
            // ignore
          }
        }
      }
    });
  });
  return server;
}
