import { matchName, NameMatch } from './matcher';
import { CodeSymbol, isMember, isType, isVariable, SearchFilter, SymbolKind } from './symbols';

export interface IndexedSymbol extends CodeSymbol {
  nameLower: string;
}

export interface IndexedFile {
  path: string;
  /** Workspace relative, with forward slashes. */
  relPath: string;
  symbols: IndexedSymbol[];
}

export type HitKind = SymbolKind | 'file';

export interface SearchHit {
  key: string;
  kind: HitKind;
  name: string;
  detail: string;
  container: string;
  file: string;
  relPath: string;
  line: number;
  column: number;
  /** Indices of the matched characters in `name`. */
  positions: number[];
}

/** A match before ranking. A short query can match most of the index, so this stays small. */
interface Candidate {
  score: number;
  kind: HitKind;
  name: string;
  line: number;
  file: IndexedFile;
  /** Absent when the file itself matched. */
  symbol?: IndexedSymbol;
  positions: number[];
}

export type FilterCounts = Record<SearchFilter, number>;

export interface SearchResponse {
  items: SearchHit[];
  counts: FilterCounts;
  /** The filter applied, which a `t:` style prefix can set. */
  filter: SearchFilter;
}

export interface SearchOptions {
  filter: SearchFilter;
  limit: number;
  /** Restricts the search to this file. */
  file?: string;
}

export interface ParsedQuery {
  filter?: SearchFilter;
  /** The text with its filter prefix removed. */
  text: string;
  /** The last dotted segment, which matches the symbol name. */
  term: string;
  /** Leading dotted segments, which must occur in the symbol's container. */
  qualifiers: string[];
}

const PREFIX_FILTERS: Record<string, SearchFilter> = {
  t: 'types',
  m: 'members',
  v: 'variables',
  f: 'files',
};

const KIND_RANK: Record<HitKind, number> = {
  class: 0,
  struct: 0,
  record: 0,
  interface: 0,
  enum: 0,
  delegate: 0,
  method: 1,
  constructor: 1,
  property: 1,
  indexer: 1,
  event: 1,
  operator: 1,
  destructor: 1,
  file: 2,
  field: 2,
  constant: 2,
  enumMember: 2,
  function: 3,
  local: 4,
  parameter: 5,
};

export function parseQuery(input: string): ParsedQuery {
  const prefixed = /^\s*([tmvf]):(.*)$/i.exec(input);
  const filter = prefixed ? PREFIX_FILTERS[prefixed[1].toLowerCase()] : undefined;
  // Pasted signatures and generics search by their name: `Load<T>(int a)` finds `Load`.
  const text = (prefixed ? prefixed[2] : input).replace(/\s+/g, '').replace(/[(<[].*$/, '');
  const segments = text.split('.').filter((segment) => segment.length > 0);
  const term = segments.pop() ?? '';
  return { filter, text, term, qualifiers: segments.map((segment) => segment.toLowerCase()) };
}

function fileNameStart(relPath: string): number {
  return relPath.lastIndexOf('/') + 1;
}

function matchFile(query: ParsedQuery, file: IndexedFile): Candidate | undefined {
  const needle = query.text.replace(/\\/g, '/');
  const name = file.relPath.slice(fileNameStart(file.relPath));

  let match: NameMatch | undefined;
  if (!needle.includes('/')) {
    match = matchName(needle, needle.toLowerCase(), name, name.toLowerCase());
  } else if (file.relPath.toLowerCase().includes(needle.toLowerCase())) {
    match = { score: 0, positions: [] };
  }
  return match && { score: match.score, kind: 'file', name, line: 0, file, positions: match.positions };
}

function toHit({ kind, name, line, file, symbol, positions }: Candidate): SearchHit {
  const location = { file: file.path, relPath: file.relPath, line, positions };
  if (symbol) {
    const { column, container, detail } = symbol;
    return { ...location, key: `${file.path}#${line}:${column}:${kind}`, kind, name, detail, container, column };
  }
  const folderEnd = Math.max(fileNameStart(file.relPath) - 1, 0);
  const container = file.relPath.slice(0, folderEnd);
  return { ...location, key: `${file.path}#file`, kind, name, detail: '', container, column: 0 };
}

function belongsTo(filter: SearchFilter, kind: HitKind): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'files':
      return kind === 'file';
    case 'types':
      return kind !== 'file' && isType(kind);
    case 'members':
      return kind !== 'file' && isMember(kind);
    case 'variables':
      return kind !== 'file' && isVariable(kind);
  }
}

function count(counts: FilterCounts, kind: HitKind): void {
  counts.all++;
  if (kind === 'file') {
    counts.files++;
    return;
  }
  if (isType(kind)) {
    counts.types++;
  }
  if (isMember(kind)) {
    counts.members++;
  }
  if (isVariable(kind)) {
    counts.variables++;
  }
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    b.score - a.score ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    a.name.length - b.name.length ||
    compareText(a.name, b.name) ||
    compareText(a.file.relPath, b.file.relPath) ||
    a.line - b.line
  );
}

/** Scores fall into a few tiers, so most candidates can be dropped without being sorted. */
function topCandidates(candidates: Candidate[], limit: number): Candidate[] {
  const tiers = new Map<number, number>();
  for (const { score } of candidates) {
    tiers.set(score, (tiers.get(score) ?? 0) + 1);
  }
  let cutoff = -Infinity;
  let kept = 0;
  for (const score of [...tiers.keys()].sort((a, b) => b - a)) {
    cutoff = score;
    kept += tiers.get(score) ?? 0;
    if (kept >= limit) {
      break;
    }
  }
  return candidates
    .filter((candidate) => candidate.score >= cutoff)
    .sort(compareCandidates)
    .slice(0, limit);
}

export function search(files: Iterable<IndexedFile>, input: string, options: SearchOptions): SearchResponse {
  const query = parseQuery(input);
  const filter = query.filter ?? options.filter;
  const counts: FilterCounts = { all: 0, types: 0, members: 0, variables: 0, files: 0 };
  if (query.text.length === 0) {
    return { items: [], counts, filter };
  }

  const term = query.term;
  const termLower = term.toLowerCase();
  const candidates: Candidate[] = [];

  for (const file of files) {
    if (options.file !== undefined && file.path !== options.file) {
      continue;
    }

    const fileMatch = matchFile(query, file);
    if (fileMatch) {
      count(counts, 'file');
      if (belongsTo(filter, 'file')) {
        candidates.push(fileMatch);
      }
    }

    if (term.length === 0) {
      continue;
    }
    for (const symbol of file.symbols) {
      const match = matchName(term, termLower, symbol.name, symbol.nameLower);
      if (!match) {
        continue;
      }
      if (query.qualifiers.length > 0) {
        const container = symbol.container.toLowerCase();
        if (!query.qualifiers.every((qualifier) => container.includes(qualifier))) {
          continue;
        }
      }
      count(counts, symbol.kind);
      if (belongsTo(filter, symbol.kind)) {
        candidates.push({
          score: match.score,
          kind: symbol.kind,
          name: symbol.name,
          line: symbol.line,
          file,
          symbol,
          positions: match.positions,
        });
      }
    }
  }

  return { items: topCandidates(candidates, options.limit).map(toHit), counts, filter };
}
