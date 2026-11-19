// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP (plain JSON answers).
// Original implementation for v3. Supports the modern `server/discover`
// era and the legacy `initialize` fallback, a frozen 6-tool list (byte-
// identical on every call), and tools/call semantics shared with REST.

import { DomainError, Forge, VIEWER_LOGIN, type Repo } from './forge.ts';
import { issueObject, pullObject, repoObject } from './httpd.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// Frozen at module load: tools/list must be byte-identical across calls.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
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
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

type JsonRpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
}

class ToolFailure extends Error {}

function pickArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    const v = args[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function requireString(args: Record<string, unknown>, names: string[], label: string): string {
  const v = pickArg(args, names);
  if (typeof v !== 'string' || v === '') {
    throw { code: -32602, message: `missing required argument: ${label}` } as RpcError;
  }
  return v;
}

function resolveRepoArg(forge: Forge, args: Record<string, unknown>): Repo {
  let owner = pickArg(args, ['owner']) as string | undefined;
  let repoName = pickArg(args, ['repo', 'repository', 'repository_name']) as string | undefined;
  const fullName = pickArg(args, ['full_name', 'fullName']) as string | undefined;
  if ((!owner || !repoName) && typeof fullName === 'string' && fullName.includes('/')) {
    const [o, r] = fullName.split('/');
    owner = owner ?? o;
    repoName = repoName ?? r;
  }
  if (!owner || !repoName) {
    throw { code: -32602, message: 'missing required arguments: owner and repo' } as RpcError;
  }
  if (owner !== VIEWER_LOGIN) throw new ToolFailure(`repository ${owner}/${repoName} not found`);
  const repo = forge.getRepo(repoName);
  if (!repo) throw new ToolFailure(`repository ${owner}/${repoName} not found`);
  return repo;
}

function toolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { message },
    isError: true,
  };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  try {
    switch (name) {
      case 'create_repo': {
        const repoName = requireString(args, ['name'], 'name');
        const description = (pickArg(args, ['description']) as string | undefined) ?? '';
        const priv = pickArg(args, ['private']) === true;
        const repo = forge.createRepo(repoName, description, priv, 'main');
        return toolResult(repoObject(forge, repo));
      }
      case 'get_repo': {
        const repo = resolveRepoArg(forge, args);
        return toolResult(repoObject(forge, repo));
      }
      case 'create_issue': {
        const repo = resolveRepoArg(forge, args);
        const title = requireString(args, ['title'], 'title');
        const body = (pickArg(args, ['body']) as string | undefined) ?? '';
        const issue = forge.createIssue(repo, title, body, []);
        return toolResult(issueObject(repo, issue));
      }
      case 'list_issues': {
        const repo = resolveRepoArg(forge, args);
        const state = ((pickArg(args, ['state']) as string | undefined) ?? 'open').toLowerCase();
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((i) => i.state === state);
        issues.sort((a, b) => a.seq - b.seq);
        return toolResult(issues.map((i) => issueObject(repo, i)));
      }
      case 'create_pull_request': {
        const repo = resolveRepoArg(forge, args);
        const title = requireString(args, ['title'], 'title');
        const head = requireString(args, ['head', 'head_branch', 'headRefName'], 'head');
        const base = requireString(args, ['base', 'base_branch', 'baseRefName'], 'base');
        const body = (pickArg(args, ['body']) as string | undefined) ?? '';
        const pull = forge.createPull(repo, head, base, title, body);
        return toolResult(pullObject(forge, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = resolveRepoArg(forge, args);
        const raw = pickArg(args, ['pull_number', 'pullNumber', 'number']);
        const num = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isInteger(num) || num < 1) {
          throw { code: -32602, message: 'missing required argument: pull_number' } as RpcError;
        }
        const { sha } = forge.mergePull(repo, num, 'merge');
        return toolResult({ sha, merged: true, message: 'Pull Request successfully merged', number: num });
      }
      default:
        throw { code: -32602, message: `unknown tool: ${name}` } as RpcError;
    }
  } catch (e) {
    if (e instanceof DomainError) return toolErrorResult(e.message);
    if (e instanceof ToolFailure) return toolErrorResult(e.message);
    throw e;
  }
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleOne(forge: Forge, msg: unknown): Record<string, unknown> | null {
  // Returns null for notifications (no response).
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = msg as Record<string, unknown>;
  const id = (req.id as JsonRpcId | undefined) ?? null;
  const hasId = req.id !== undefined;
  const method = req.method;
  if (typeof method !== 'string') {
    if (!hasId) return null;
    return rpcError(id, -32600, 'Invalid Request');
  }
  if (method.startsWith('notifications/')) {
    return null;
  }
  if (!hasId) {
    // Any other notification: no response.
    return null;
  }
  const params = (req.params ?? {}) as Record<string, unknown>;
  try {
    switch (method) {
      case 'server/discover': {
        return rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          _meta: {
            'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
          },
        });
      }
      case 'initialize': {
        const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }
      case 'ping': {
        return rpcResult(id, {});
      }
      case 'tools/list': {
        return rpcResult(id, { tools: TOOLS });
      }
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || !name) {
          return rpcError(id, -32602, 'missing tool name');
        }
        if (!TOOL_NAMES.has(name)) {
          return rpcError(id, -32602, `unknown tool: ${name}`);
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const result = callTool(forge, name, args);
        return rpcResult(id, result);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && typeof (e as RpcError).code === 'number') {
      const err = e as RpcError;
      return rpcError(id, err.code, err.message);
    }
    return rpcError(id, -32603, e instanceof Error ? e.message : 'Internal error');
  }
}

export function handleMCP(forge: Forge, rawBody: Buffer): { status: number; payload: unknown | null } {
  let parsed: unknown;
  try {
    parsed = rawBody.length === 0 ? null : JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      payload: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (parsed === null || parsed === undefined) {
    return {
      status: 400,
      payload: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const item of parsed) {
      const r = handleOne(forge, item);
      if (r) responses.push(r);
    }
    if (responses.length === 0) return { status: 202, payload: null };
    return { status: 200, payload: responses };
  }
  const response = handleOne(forge, parsed);
  if (response === null) return { status: 202, payload: null };
  return { status: 200, payload: response };
}
