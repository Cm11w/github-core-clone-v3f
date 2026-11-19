// GraphQL v4 endpoint: a small spec-shaped parser, schema-driven
// validator, and executor. Original implementation for v3. Supports the
// full surface the conformance suite exercises: operations with
// variables, aliases, arguments (incl. input objects), inline fragments,
// named fragments, batch requests, and __type introspection.

import {
  DomainError,
  EPOCH_ISO,
  Forge,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commentNodeId,
  decodeNodeId,
  type Issue,
  type Pull,
  type Repo,
} from './forge.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

class GraphQLError extends Error {}

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        // Block string: take raw content, strip common indent.
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new GraphQLError('unterminated block string');
        let raw = src.slice(i + 3, end);
        i = end + 3;
        raw = raw.replace(/^\n/, '').replace(/\n$/, '');
        const lines = raw.split('\n');
        let indent: number | null = null;
        for (let k = 1; k < lines.length; k++) {
          const line = lines[k]!;
          if (line.trim() === '') continue;
          const m = /^ */.exec(line)!;
          const w = m[0].length;
          if (indent === null || w < indent) indent = w;
        }
        if (indent) {
          for (let k = 1; k < lines.length; k++) lines[k] = lines[k]!.slice(indent);
        }
        tokens.push({ kind: 'string', value: lines.join('\n') });
        continue;
      }
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) throw new GraphQLError('unterminated string');
        const ch = src[j]!;
        if (ch === '"') {
          j++;
          break;
        }
        if (ch === '\n') throw new GraphQLError('newline in string');
        if (ch === '\\') {
          const esc = src[j + 1];
          if (esc === undefined) throw new GraphQLError('bad escape');
          if (esc === 'u') {
            const hex = src.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new GraphQLError('bad unicode escape');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else {
            const map: Record<string, string> = {
              '"': '"',
              '\\': '\\',
              '/': '/',
              b: '\b',
              f: '\f',
              n: '\n',
              r: '\r',
              t: '\t',
            };
            if (!(esc in map)) throw new GraphQLError('bad escape');
            out += map[esc]!;
            j += 2;
          }
          continue;
        }
        out += ch;
        j++;
      }
      tokens.push({ kind: 'string', value: out });
      i = j;
      continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < n && src[j]! >= '0' && src[j]! <= '9') j++;
      let isFloat = false;
      if (src[j] === '.' && src[j + 1]! >= '0' && src[j + 1]! <= '9') {
        isFloat = true;
        j++;
        while (j < n && src[j]! >= '0' && src[j]! <= '9') j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (src[k]! >= '0' && src[k]! <= '9') {
          isFloat = true;
          j = k;
          while (j < n && src[j]! >= '0' && src[j]! <= '9') j++;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /[_A-Za-z0-9]/.test(src[j]!)) j++;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new GraphQLError(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

export type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; of: TypeNode }
  | { kind: 'nonNull'; of: TypeNode };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<[string, ValueNode]>;
  selectionSet: SelectionNode[] | null;
}

export interface SpreadNode {
  kind: 'spread';
  name: string;
}

export interface InlineNode {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: SelectionNode[];
}

export type SelectionNode = FieldNode | SpreadNode | InlineNode;

export interface VarDef {
  name: string;
  type: TypeNode;
  defaultValue: ValueNode | null;
}

export interface OperationDef {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: VarDef[];
  selectionSet: SelectionNode[];
}

export interface FragmentDef {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export interface Document {
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new GraphQLError(`expected '${v}'`);
  }
  private expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new GraphQLError('expected name');
    if (v !== undefined && t.value !== v) throw new GraphQLError(`expected '${v}'`);
    return t.value;
  }
  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArgs();
    }
  }

  parseDocument(): Document {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({
          kind: 'query',
          name: null,
          varDefs: [],
          selectionSet: this.parseSelectionSet(),
        });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
        const kind = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        let varDefs: VarDef[] = [];
        if (this.peek().kind === 'punct' && this.peek().value === '(') varDefs = this.parseVarDefs();
        this.skipDirectives();
        operations.push({ kind, name, varDefs, selectionSet: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new GraphQLError('unexpected definition');
      }
    }
    return { operations, fragments };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseType(): TypeNode {
    let type: TypeNode;
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = { kind: 'list', of: inner };
    } else {
      type = { kind: 'named', name: this.expectName() };
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      type = { kind: 'nonNull', of: type };
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new GraphQLError('unterminated selection set');
      sels.push(this.parseSelection());
    }
    this.expectPunct('}');
    return sels;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const nt = this.peek();
      if (nt.kind === 'name' && nt.value !== 'on') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      let typeCondition: string | null = null;
      if (nt.kind === 'name' && nt.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    let args: Array<[string, ValueNode]> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArgs();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArgs(): Array<[string, ValueNode]> {
    const args: Array<[string, ValueNode]> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push([name, this.parseValue(false)]);
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(constant: boolean): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$' && !constant) {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue(constant));
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push([name, this.parseValue(constant)]);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new GraphQLError('unexpected value');
  }
}

export function parseGraphQL(src: string): Document {
  return new Parser(lex(src)).parseDocument();
}

// ---------------------------------------------------------------------------
// Schema table (single source for validation + introspection)
// ---------------------------------------------------------------------------

type TypeKind = 'OBJECT' | 'INTERFACE' | 'ENUM' | 'SCALAR';

interface TypeDef {
  kind: TypeKind;
  fields?: Record<string, string>;
  values?: string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: 'User',
      repository: 'Repository',
      node: 'Node',
      __type: '__Type',
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: 'CreateIssuePayload',
      closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload',
      mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: 'ID' } },
  User: {
    kind: 'OBJECT',
    fields: { id: 'ID', login: 'String', name: 'String', email: 'String' },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: 'ID',
      databaseId: 'Int',
      name: 'String',
      nameWithOwner: 'String',
      description: 'String',
      owner: 'User',
      defaultBranchRef: 'Ref',
      viewerPermission: 'RepositoryPermission',
      hasIssuesEnabled: 'Boolean',
      url: 'String',
      issue: 'Issue',
      issues: 'IssueConnection',
      pullRequest: 'PullRequest',
      pullRequests: 'PullRequestConnection',
    },
  },
  Ref: { kind: 'OBJECT', fields: { name: 'String', prefix: 'String' } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: 'ID',
      databaseId: 'Int',
      number: 'Int',
      title: 'String',
      body: 'String',
      state: 'IssueState',
      url: 'String',
      author: 'User',
      createdAt: 'String',
      updatedAt: 'String',
      closedAt: 'String',
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: 'Issue', cursor: 'String' } },
  PageInfo: {
    kind: 'OBJECT',
    fields: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: 'ID',
      databaseId: 'Int',
      number: 'Int',
      title: 'String',
      body: 'String',
      state: 'PullRequestState',
      merged: 'Boolean',
      mergeable: 'MergeableState',
      headRefName: 'String',
      baseRefName: 'String',
      files: 'PullRequestChangedFileConnection',
      url: 'String',
      author: 'User',
      createdAt: 'String',
      mergedAt: 'String',
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: 'PullRequest', cursor: 'String' } },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo', totalCount: 'Int' },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: { id: 'ID', body: 'String', author: 'User', createdAt: 'String' },
  },
  CommentEdge: { kind: 'OBJECT', fields: { node: 'IssueComment', cursor: 'String' } },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: 'Issue', clientMutationId: 'String' },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: 'Issue', clientMutationId: 'String' },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { commentEdge: 'CommentEdge', clientMutationId: 'String' },
  },
  __Type: {
    kind: 'OBJECT',
    fields: { name: 'String', kind: 'String', fields: '[__Field]', enumValues: '[__EnumValue]' },
  },
  __Field: { kind: 'OBJECT', fields: { name: 'String', description: 'String' } },
  __EnumValue: { kind: 'OBJECT', fields: { name: 'String', description: 'String' } },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  SearchType: {
    kind: 'ENUM',
    values: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

function baseTypeName(t: string): string {
  return t.replace(/[\[\]!]/g, '');
}

function isComposite(t: string): boolean {
  const def = SCHEMA[baseTypeName(t)];
  return !!def && (def.kind === 'OBJECT' || def.kind === 'INTERFACE');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateDocument(doc: Document, op: OperationDef): string[] {
  const errors: string[] = [];
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const validateSel = (
    parentType: string,
    sels: SelectionNode[],
    spreadStack: Set<string>,
  ): void => {
    for (const sel of sels) {
      if (sel.kind === 'field') {
        if (sel.name === '__typename') continue;
        const def = SCHEMA[parentType];
        const fieldType = def?.fields?.[sel.name];
        if (!fieldType) {
          errors.push(`Cannot query field "${sel.name}" on type "${parentType}".`);
          continue;
        }
        if (isComposite(fieldType)) {
          if (!sel.selectionSet) {
            errors.push(`Field "${sel.name}" of type "${fieldType}" must have a selection of subfields.`);
          } else {
            validateSel(baseTypeName(fieldType), sel.selectionSet, spreadStack);
          }
        } else if (sel.selectionSet) {
          errors.push(`Field "${sel.name}" must not have a selection since type "${fieldType}" has no subfields.`);
        }
      } else if (sel.kind === 'spread') {
        const frag = doc.fragments.get(sel.name);
        if (!frag) {
          errors.push(`Unknown fragment "${sel.name}".`);
          continue;
        }
        if (spreadStack.has(sel.name)) {
          errors.push(`Fragment cycle involving "${sel.name}".`);
          continue;
        }
        if (!SCHEMA[frag.typeCondition]) {
          errors.push(`Unknown type "${frag.typeCondition}".`);
          continue;
        }
        spreadStack.add(sel.name);
        validateSel(frag.typeCondition, frag.selectionSet, spreadStack);
        spreadStack.delete(sel.name);
      } else {
        const cond = sel.typeCondition ?? parentType;
        if (!SCHEMA[cond]) {
          errors.push(`Unknown type "${cond}".`);
          continue;
        }
        validateSel(cond, sel.selectionSet, spreadStack);
      }
    }
  };
  validateSel(rootType, op.selectionSet, new Set());
  return errors;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

class FieldError extends Error {}

interface GQLObject {
  __typename: string;
  [key: string]: unknown;
}

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
  depth: number;
}

function valueFromAst(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = ctx.variables[node.name];
      return v === undefined ? null : v;
    }
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'enum':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => valueFromAst(v, ctx));
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of node.fields) obj[k] = valueFromAst(v, ctx);
      return obj;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = valueFromAst(v, ctx);
  return out;
}

function userInternal(): GQLObject {
  return { __typename: 'User' };
}

function repoInternal(repo: Repo): GQLObject {
  return { __typename: 'Repository', repo };
}

function issueInternal(repo: Repo, issue: Issue): GQLObject {
  return { __typename: 'Issue', repo, issue };
}

function pullInternal(repo: Repo, pull: Pull): GQLObject {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorFor(kind: string, n: number): string {
  return Buffer.from(`${kind}:${n}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: string | unknown, kind: string): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const s = Buffer.from(cursor, 'base64url').toString('utf8');
    const [k, v] = s.split(':');
    if (k !== kind) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function pageInfoFor(total: number, start: number, taken: number, firstKey: string | null, lastKey: string | null): GQLObject {
  return {
    __typename: 'PageInfo',
    hasNextPage: start + taken < total,
    hasPreviousPage: start > 0,
    startCursor: firstKey,
    endCursor: lastKey,
  };
}

type Resolver = (obj: GQLObject, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userInternal(),
    repository: (_o, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ctx.forge.getRepo(name);
      return repo ? repoInternal(repo) : null;
    },
    node: (_o, args, ctx) => {
      const decoded = decodeNodeId(args.id as string);
      if (!decoded) return null;
      if (decoded.kind === 'repo') {
        const repo = ctx.forge.reposById.get(decoded.id);
        return repo ? repoInternal(repo) : null;
      }
      if (decoded.kind === 'issue') {
        const repo = ctx.forge.reposById.get(decoded.repoId);
        const issue = repo?.issues.get(decoded.number);
        return repo && issue ? issueInternal(repo, issue) : null;
      }
      if (decoded.kind === 'pull') {
        const repo = ctx.forge.reposById.get(decoded.repoId);
        const pull = repo?.pulls.get(decoded.number);
        return repo && pull ? pullInternal(repo, pull) : null;
      }
      return null;
    },
    __type: (_o, args) => {
      const name = args.name as string;
      const def = SCHEMA[name];
      if (!def) return null;
      return { __typename: '__Type', typeName: name, def };
    },
  },
  User: {
    id: () => Buffer.from(`U:${VIEWER_ID}`, 'utf8').toString('base64url'),
    login: () => VIEWER_LOGIN,
    name: () => VIEWER_NAME,
    email: () => VIEWER_EMAIL,
  },
  Repository: {
    id: (o) => (o.repo as Repo).nodeId,
    databaseId: (o) => (o.repo as Repo).id,
    name: (o) => (o.repo as Repo).name,
    nameWithOwner: (o) => `${VIEWER_LOGIN}/${(o.repo as Repo).name}`,
    description: (o) => (o.repo as Repo).description,
    owner: () => userInternal(),
    defaultBranchRef: (o, _a, ctx) => {
      const repo = o.repo as Repo;
      const ref = `refs/heads/${repo.defaultBranch}`;
      if (!repo.refs.has(ref)) return null;
      return { __typename: 'Ref', name: repo.defaultBranch };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (o) => `http://localhost/${VIEWER_LOGIN}/${(o.repo as Repo).name}`,
    issue: (o, args) => {
      const repo = o.repo as Repo;
      const issue = repo.issues.get(args.number as number);
      return issue ? issueInternal(repo, issue) : null;
    },
    issues: (o, args) => {
      const repo = o.repo as Repo;
      let items = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (states && states.length > 0) {
        const wanted = new Set(states.map((s) => s.toLowerCase()));
        items = items.filter((i) => wanted.has(i.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const field = (orderBy.field as string) ?? 'CREATED_AT';
      const direction = (orderBy.direction as string) ?? 'DESC';
      const keyOf = (i: Issue): number =>
        field === 'UPDATED_AT' ? i.updatedSeq : field === 'COMMENTS' ? i.comments.length : i.seq;
      items.sort((a, b) => {
        const d = keyOf(a) - keyOf(b);
        if (d !== 0) return direction === 'ASC' ? d : -d;
        return direction === 'ASC' ? a.number - b.number : b.number - a.number;
      });
      const total = items.length;
      let start = 0;
      const afterNum = cursorNumber(args.after, 'i');
      if (afterNum !== null) {
        const idx = items.findIndex((i) => i.number === afterNum);
        if (idx !== -1) start = idx + 1;
      }
      const first = (args.first as number | undefined) ?? 30;
      const page = items.slice(start, start + first);
      const nodes = page.map((i) => issueInternal(repo, i));
      return {
        __typename: 'IssueConnection',
        nodes,
        edges: page.map((i) => ({
          __typename: 'IssueEdge',
          node: issueInternal(repo, i),
          cursor: cursorFor('i', i.number),
        })),
        pageInfo: pageInfoFor(
          total,
          start,
          page.length,
          page.length > 0 ? cursorFor('i', page[0]!.number) : null,
          page.length > 0 ? cursorFor('i', page[page.length - 1]!.number) : null,
        ),
        totalCount: total,
      };
    },
    pullRequest: (o, args) => {
      const repo = o.repo as Repo;
      const pull = repo.pulls.get(args.number as number);
      return pull ? pullInternal(repo, pull) : null;
    },
    pullRequests: (o, args) => {
      const repo = o.repo as Repo;
      let items = [...repo.pulls.values()];
      const states = args.states as string[] | undefined;
      if (states && states.length > 0) {
        const wanted = new Set(
          states.map((s) => (s === 'MERGED' ? 'merged' : s.toLowerCase())),
        );
        items = items.filter((p) => wanted.has(p.merged ? 'merged' : p.state));
      } else {
        items = items.filter((p) => p.state === 'open');
      }
      items.sort((a, b) => b.seq - a.seq);
      const total = items.length;
      let start = 0;
      const afterNum = cursorNumber(args.after, 'p');
      if (afterNum !== null) {
        const idx = items.findIndex((p) => p.number === afterNum);
        if (idx !== -1) start = idx + 1;
      }
      const first = (args.first as number | undefined) ?? 30;
      const page = items.slice(start, start + first);
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((p) => pullInternal(repo, p)),
        edges: page.map((p) => ({
          __typename: 'PullRequestEdge',
          node: pullInternal(repo, p),
          cursor: cursorFor('p', p.number),
        })),
        pageInfo: pageInfoFor(
          total,
          start,
          page.length,
          page.length > 0 ? cursorFor('p', page[0]!.number) : null,
          page.length > 0 ? cursorFor('p', page[page.length - 1]!.number) : null,
        ),
        totalCount: total,
      };
    },
  },
  Ref: {
    name: (o) => o.name as string,
    prefix: () => 'refs/heads/',
  },
  Issue: {
    id: (o) => (o.issue as Issue).nodeId,
    databaseId: (o) => (o.issue as Issue).number,
    number: (o) => (o.issue as Issue).number,
    title: (o) => (o.issue as Issue).title,
    body: (o) => (o.issue as Issue).body,
    state: (o) => ((o.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    url: (o) => `http://localhost/${VIEWER_LOGIN}/${(o.repo as Repo).name}/issues/${(o.issue as Issue).number}`,
    author: () => userInternal(),
    createdAt: () => EPOCH_ISO,
    updatedAt: () => EPOCH_ISO,
    closedAt: (o) => (o.issue as Issue).closedAt,
  },
  IssueConnection: {
    nodes: (o) => o.nodes as GQLObject[],
    edges: (o) => o.edges as GQLObject[],
    pageInfo: (o) => o.pageInfo as GQLObject,
    totalCount: (o) => o.totalCount as number,
  },
  IssueEdge: {
    node: (o) => o.node as GQLObject,
    cursor: (o) => o.cursor as string,
  },
  PageInfo: {
    hasNextPage: (o) => o.hasNextPage as boolean,
    hasPreviousPage: (o) => o.hasPreviousPage as boolean,
    startCursor: (o) => o.startCursor as string | null,
    endCursor: (o) => o.endCursor as string | null,
  },
  PullRequest: {
    id: (o) => (o.pull as Pull).nodeId,
    databaseId: (o) => (o.pull as Pull).number,
    number: (o) => (o.pull as Pull).number,
    title: (o) => (o.pull as Pull).title,
    body: (o) => (o.pull as Pull).body,
    state: (o) => {
      const p = o.pull as Pull;
      if (p.merged) return 'MERGED';
      return p.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (o) => (o.pull as Pull).merged,
    mergeable: (o, _a, ctx) => {
      const repo = o.repo as Repo;
      const pull = o.pull as Pull;
      if (pull.merged) return 'UNKNOWN';
      return ctx.forge.pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (o) => (o.pull as Pull).head,
    baseRefName: (o) => (o.pull as Pull).base,
    files: (o, args, ctx) => {
      const repo = o.repo as Repo;
      const pull = o.pull as Pull;
      const all = ctx.forge.pullFiles(repo, pull);
      const first = (args.first as number | undefined) ?? all.length;
      const page = all.slice(0, first);
      const nodes = page.map((f) => ({
        __typename: 'PullRequestChangedFile',
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes,
        pageInfo: pageInfoFor(all.length, 0, page.length, null, null),
        totalCount: all.length,
      };
    },
    url: (o) => `http://localhost/${VIEWER_LOGIN}/${(o.repo as Repo).name}/pull/${(o.pull as Pull).number}`,
    author: () => userInternal(),
    createdAt: () => EPOCH_ISO,
    mergedAt: (o) => (o.pull as Pull).mergedAt,
  },
  PullRequestConnection: {
    nodes: (o) => o.nodes as GQLObject[],
    edges: (o) => o.edges as GQLObject[],
    pageInfo: (o) => o.pageInfo as GQLObject,
    totalCount: (o) => o.totalCount as number,
  },
  PullRequestEdge: {
    node: (o) => o.node as GQLObject,
    cursor: (o) => o.cursor as string,
  },
  PullRequestChangedFileConnection: {
    nodes: (o) => o.nodes as GQLObject[],
    pageInfo: (o) => o.pageInfo as GQLObject,
    totalCount: (o) => o.totalCount as number,
  },
  PullRequestChangedFile: {
    path: (o) => o.path as string,
    additions: (o) => o.additions as number,
    deletions: (o) => o.deletions as number,
    changeType: (o) => o.changeType as string,
  },
  IssueComment: {
    id: (o) => o.commentId as string,
    body: (o) => o.commentBody as string,
    author: () => userInternal(),
    createdAt: () => EPOCH_ISO,
  },
  CommentEdge: {
    node: (o) => o.node as GQLObject,
    cursor: (o) => o.cursor as string,
  },
  CreateIssuePayload: {
    issue: (o) => o.issue as GQLObject,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (o) => o.issue as GQLObject,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (o) => o.pullRequest as GQLObject,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (o) => o.pullRequest as GQLObject,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (o) => o.commentEdge as GQLObject,
    clientMutationId: () => null,
  },
  __Type: {
    name: (o) => o.typeName as string,
    kind: (o) => (o.def as TypeDef).kind,
    fields: (o) => {
      const def = o.def as TypeDef;
      if (!def.fields) return null;
      return Object.keys(def.fields).map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (o) => {
      const def = o.def as TypeDef;
      if (!def.values) return null;
      return def.values.map((name) => ({ __typename: '__EnumValue', name }));
    },
  },
  __Field: {
    name: (o) => o.name as string,
    description: () => null,
  },
  __EnumValue: {
    name: (o) => o.name as string,
    description: () => null,
  },
  Mutation: {
    createIssue: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(input.repositoryId as string);
      if (!decoded || decoded.kind !== 'repo') throw new FieldError('Repository not found');
      const repo = ctx.forge.reposById.get(decoded.id);
      if (!repo) throw new FieldError('Repository not found');
      try {
        const issue = ctx.forge.createIssue(repo, input.title as string, (input.body as string) ?? '', []);
        return { __typename: 'CreateIssuePayload', issue: issueInternal(repo, issue) };
      } catch (e) {
        if (e instanceof DomainError) throw new FieldError(e.message);
        throw e;
      }
    },
    closeIssue: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(input.issueId as string);
      if (!decoded || decoded.kind !== 'issue') throw new FieldError('Issue not found');
      const repo = ctx.forge.reposById.get(decoded.repoId);
      const issue = repo?.issues.get(decoded.number);
      if (!repo || !issue) throw new FieldError('Issue not found');
      ctx.forge.patchIssue(repo, decoded.number, { state: 'closed' });
      return { __typename: 'CloseIssuePayload', issue: issueInternal(repo, issue) };
    },
    createPullRequest: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(input.repositoryId as string);
      if (!decoded || decoded.kind !== 'repo') throw new FieldError('Repository not found');
      const repo = ctx.forge.reposById.get(decoded.id);
      if (!repo) throw new FieldError('Repository not found');
      try {
        const pull = ctx.forge.createPull(
          repo,
          input.headRefName as string,
          input.baseRefName as string,
          input.title as string,
          (input.body as string) ?? '',
        );
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullInternal(repo, pull) };
      } catch (e) {
        if (e instanceof DomainError) throw new FieldError(e.message);
        throw e;
      }
    },
    mergePullRequest: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(input.pullRequestId as string);
      if (!decoded || decoded.kind !== 'pull') throw new FieldError('Pull request not found');
      const repo = ctx.forge.reposById.get(decoded.repoId);
      const pull = repo?.pulls.get(decoded.number);
      if (!repo || !pull) throw new FieldError('Pull request not found');
      try {
        ctx.forge.mergePull(repo, decoded.number, (input.mergeMethod as string) ?? 'MERGE');
        return { __typename: 'MergePullRequestPayload', pullRequest: pullInternal(repo, pull) };
      } catch (e) {
        if (e instanceof DomainError) throw new FieldError(e.message);
        throw e;
      }
    },
    addComment: (_o, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeNodeId(input.subjectId as string);
      const body = input.body as string;
      if (!body) throw new FieldError('body is required');
      let commentId = '';
      if (decoded?.kind === 'issue') {
        const repo = ctx.forge.reposById.get(decoded.repoId);
        if (!repo || !repo.issues.has(decoded.number)) throw new FieldError('Issue not found');
        const comment = ctx.forge.addIssueComment(repo, decoded.number, body);
        commentId = comment.nodeId;
      } else if (decoded?.kind === 'pull') {
        const repo = ctx.forge.reposById.get(decoded.repoId);
        const pull = repo?.pulls.get(decoded.number);
        if (!repo || !pull) throw new FieldError('Pull request not found');
        const id = ctx.forge.nextObjectId++;
        const nodeId = commentNodeId(id);
        pull.comments.push({ id, nodeId, body, seq: ctx.forge.nextSeq++ });
        commentId = nodeId;
      } else {
        throw new FieldError('Subject not found');
      }
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'IssueComment', commentId, commentBody: body },
          cursor: '',
        },
      };
    },
  },
};

function executeSelectionSet(
  parentType: string,
  obj: GQLObject,
  sels: SelectionNode[],
  ctx: ExecCtx,
  spreadStack: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.depth > 50) return out;
  for (const sel of sels) {
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (!frag || spreadStack.has(sel.name)) continue;
      if (frag.typeCondition !== parentType && frag.typeCondition !== obj.__typename) {
        // Fragment on another concrete type does not apply here; but a
        // fragment on an interface (Node) applies to all its members.
        if (frag.typeCondition !== 'Node') continue;
      }
      spreadStack.add(sel.name);
      const sub = executeSelectionSet(frag.typeCondition, obj, frag.selectionSet, ctx, spreadStack);
      spreadStack.delete(sel.name);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inline') {
      const cond = sel.typeCondition;
      if (cond && cond !== parentType && cond !== obj.__typename && cond !== 'Node') continue;
      const sub = executeSelectionSet(cond ?? parentType, obj, sel.selectionSet, ctx, spreadStack);
      Object.assign(out, sub);
      continue;
    }
    const key = sel.alias ?? sel.name;
    if (sel.name === '__typename') {
      out[key] = obj.__typename;
      continue;
    }
    const resolver = RESOLVERS[parentType]?.[sel.name] ?? RESOLVERS[obj.__typename]?.[sel.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(obj, argsOf(sel, ctx), ctx);
    } catch (e) {
      if (e instanceof FieldError) {
        ctx.errors.push({ message: e.message });
        out[key] = null;
        continue;
      }
      throw e;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (!sel.selectionSet) {
      out[key] = value;
      continue;
    }
    const fieldType = SCHEMA[parentType]?.fields?.[sel.name] ?? SCHEMA[obj.__typename]?.fields?.[sel.name];
    const childType = fieldType ? baseTypeName(fieldType) : obj.__typename;
    ctx.depth++;
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (item === null || typeof item !== 'object') return item;
        const itemObj = item as GQLObject;
        return executeSelectionSet(itemObj.__typename || childType, itemObj, sel.selectionSet!, ctx, new Set(spreadStack));
      });
    } else if (typeof value === 'object') {
      const valueObj = value as GQLObject;
      out[key] = executeSelectionSet(valueObj.__typename || childType, valueObj, sel.selectionSet, ctx, new Set(spreadStack));
    } else {
      out[key] = value;
    }
    ctx.depth--;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

function executeOne(
  forge: Forge,
  payload: unknown,
): { status: number; body: Record<string, unknown> } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, body: { errors: [{ message: 'request body must be a JSON object' }] } };
  }
  const req = payload as Record<string, unknown>;
  const queryText = req.query;
  if (typeof queryText !== 'string' || !queryText.trim()) {
    return { status: 400, body: { errors: [{ message: 'query is required' }] } };
  }
  let doc: Document;
  try {
    doc = parseGraphQL(queryText);
  } catch (e) {
    return { status: 200, body: { data: null, errors: [{ message: e instanceof Error ? e.message : 'syntax error' }] } };
  }
  const operationName = typeof req.operationName === 'string' ? req.operationName : null;
  let op: OperationDef | undefined;
  if (operationName) {
    op = doc.operations.find((o) => o.name === operationName);
    if (!op) {
      return { status: 200, body: { data: null, errors: [{ message: `unknown operation "${operationName}"` }] } };
    }
  } else {
    op = doc.operations[0];
  }
  if (!op) {
    return { status: 200, body: { data: null, errors: [{ message: 'no operation found' }] } };
  }
  if (op.kind === 'subscription') {
    return { status: 200, body: { data: null, errors: [{ message: 'Subscriptions are not supported' }] } };
  }
  const validationErrors = validateDocument(doc, op);
  if (validationErrors.length > 0) {
    return { status: 200, body: { data: null, errors: validationErrors.map((m) => ({ message: m })) } };
  }
  const requestVars = (req.variables ?? {}) as Record<string, unknown>;
  const variables: Record<string, unknown> = {};
  const varCtx: ExecCtx = {
    forge,
    variables: requestVars,
    fragments: doc.fragments,
    errors: [],
    depth: 0,
  };
  for (const def of op.varDefs) {
    if (requestVars[def.name] !== undefined) {
      variables[def.name] = requestVars[def.name];
    } else if (def.defaultValue) {
      variables[def.name] = valueFromAst(def.defaultValue, varCtx);
    }
  }
  for (const [k, v] of Object.entries(requestVars)) {
    if (!(k in variables)) variables[k] = v;
  }
  const ctx: ExecCtx = { forge, variables, fragments: doc.fragments, errors: [], depth: 0 };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GQLObject = { __typename: rootType };
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(rootType, root, op.selectionSet, ctx, new Set());
  } catch (e) {
    return {
      status: 200,
      body: { data: null, errors: [{ message: e instanceof Error ? e.message : 'internal error' }] },
    };
  }
  if (ctx.errors.length > 0) {
    return { status: 200, body: { data, errors: ctx.errors } };
  }
  return { status: 200, body: { data } };
}

export function handleGraphQL(forge: Forge, rawBody: Buffer): { status: number; payload: unknown } {
  let parsed: unknown;
  try {
    parsed = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, payload: { errors: [{ message: 'request body must be valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => executeOne(forge, item).body);
    return { status: 200, payload: results };
  }
  const { status, body } = executeOne(forge, parsed);
  return { status, payload: body };
}
