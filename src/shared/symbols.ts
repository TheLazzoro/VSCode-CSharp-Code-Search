export type SymbolKind =
  | 'class'
  | 'struct'
  | 'record'
  | 'interface'
  | 'enum'
  | 'delegate'
  | 'method'
  | 'constructor'
  | 'destructor'
  | 'operator'
  | 'function'
  | 'property'
  | 'indexer'
  | 'event'
  | 'field'
  | 'constant'
  | 'enumMember'
  | 'local'
  | 'parameter';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** Zero-based position of the name, in UTF-16 code units. */
  line: number;
  column: number;
  /** Dotted path of the enclosing namespace, types and methods. */
  container: string;
  /** Signature or type, for display next to the name. */
  detail: string;
}

export type SearchFilter = 'all' | 'types' | 'members' | 'variables' | 'files';
export type SearchScope = 'workspace' | 'document';

const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set(['class', 'struct', 'record', 'interface', 'enum', 'delegate']);
const VARIABLE_KINDS: ReadonlySet<SymbolKind> = new Set(['field', 'constant', 'local', 'parameter']);
const NON_MEMBER_KINDS: ReadonlySet<SymbolKind> = new Set(['local', 'parameter']);

export function isType(kind: SymbolKind): boolean {
  return TYPE_KINDS.has(kind);
}

/** Fields and constants are both members and variables, so they appear under both tabs. */
export function isVariable(kind: SymbolKind): boolean {
  return VARIABLE_KINDS.has(kind);
}

export function isMember(kind: SymbolKind): boolean {
  return !TYPE_KINDS.has(kind) && !NON_MEMBER_KINDS.has(kind);
}

/** Syntax classes of the code preview. Index 0 means unstyled. */
export const TOKEN_CLASSES = [
  'plain',
  'keyword',
  'declaration',
  'control',
  'type',
  'builtin',
  'function',
  'variable',
  'parameter',
  'property',
  'namespace',
  'string',
  'escape',
  'number',
  'constant',
  'comment',
  'operator',
  'punctuation',
  'preprocessor',
] as const;

export type TokenClass = (typeof TOKEN_CLASSES)[number];

export interface HighlightedSource {
  lines: string[];
  /** For each line, a flat list of `start, length, tokenClassIndex` triples. */
  spans: number[][];
}
