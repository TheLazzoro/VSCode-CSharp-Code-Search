import type { SearchHit, FilterCounts } from './search';
import type { HighlightedSource, SearchFilter, SearchScope, TokenClass } from './symbols';

export interface QueryState {
  text: string;
  filter: SearchFilter;
  scope: SearchScope;
}

export type TokenColors = Partial<Record<TokenClass, string>>;

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  length: number;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'query'; seq: number; query: QueryState }
  | { type: 'preview'; file: string }
  | { type: 'open'; location: SourceLocation; beside: boolean }
  | { type: 'close' };

export type HostMessage =
  | { type: 'init'; query: QueryState; documentName?: string }
  | { type: 'focus'; text?: string; documentName?: string; selectAll?: boolean }
  | { type: 'results'; seq: number; items: SearchHit[]; counts: FilterCounts; filter: SearchFilter }
  | { type: 'status'; indexing: boolean; indexed: number; total: number; symbols: number }
  | { type: 'source'; file: string; relPath: string; source?: HighlightedSource }
  | { type: 'invalidate'; file?: string }
  | { type: 'theme'; colors: TokenColors };
