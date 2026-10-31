import type { HostMessage, QueryState, SourceLocation, TokenColors, WebviewMessage } from '../shared/protocol';
import type { FilterCounts, HitKind, SearchHit } from '../shared/search';
import { HighlightedSource, SearchFilter, SearchScope, TOKEN_CLASSES } from '../shared/symbols';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
}

interface PersistedState {
  previewHeight?: number;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const QUERY_DEBOUNCE_MS = 40;
const PREVIEW_DEBOUNCE_MS = 40;
const MAX_CACHED_SOURCES = 16;
const OVERSCAN_LINES = 10;
const TAB_SIZE = 4;
const MIN_PANE_HEIGHT = 80;
const PAGE_ROWS = 10;

interface KindStyle {
  label: string;
  icon: string;
  /** Suffix of the theme's `--vscode-symbolIcon-*Foreground` color. */
  color: string;
}

const KIND_STYLES: Record<HitKind, KindStyle> = {
  class: { label: 'Class', icon: 'symbol-class', color: 'class' },
  struct: { label: 'Struct', icon: 'symbol-structure', color: 'struct' },
  record: { label: 'Record', icon: 'symbol-class', color: 'class' },
  interface: { label: 'Interface', icon: 'symbol-interface', color: 'interface' },
  enum: { label: 'Enum', icon: 'symbol-enum', color: 'enumerator' },
  delegate: { label: 'Delegate', icon: 'symbol-method', color: 'method' },
  method: { label: 'Method', icon: 'symbol-method', color: 'method' },
  constructor: { label: 'Constructor', icon: 'symbol-method', color: 'constructor' },
  destructor: { label: 'Destructor', icon: 'symbol-method', color: 'constructor' },
  operator: { label: 'Operator', icon: 'symbol-operator', color: 'operator' },
  function: { label: 'Local function', icon: 'symbol-method', color: 'function' },
  property: { label: 'Property', icon: 'symbol-property', color: 'property' },
  indexer: { label: 'Indexer', icon: 'symbol-property', color: 'property' },
  event: { label: 'Event', icon: 'symbol-event', color: 'event' },
  field: { label: 'Field', icon: 'symbol-field', color: 'field' },
  constant: { label: 'Constant', icon: 'symbol-constant', color: 'constant' },
  enumMember: { label: 'Enum member', icon: 'symbol-enum-member', color: 'enumeratorMember' },
  local: { label: 'Local variable', icon: 'symbol-variable', color: 'variable' },
  parameter: { label: 'Parameter', icon: 'symbol-parameter', color: 'variable' },
  file: { label: 'File', icon: 'file-code', color: 'file' },
};

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const app = element('app');
const input = element<HTMLInputElement>('query');
const tabs = element('tabs');
const statusText = element('status');
const scopeSelect = element<HTMLSelectElement>('scope');
const progress = element('progress');
const progressBar = element('progress-bar');
const resultsPane = element('results');
const splitter = element('splitter');
const previewHeader = element('preview-header');
const codePane = element('code');
const codeSizer = element('code-sizer');
const codeLines = element('code-lines');

const tabButtons = new Map<SearchFilter, HTMLButtonElement>(
  Array.from(tabs.querySelectorAll('button'), (button) => [button.dataset.filter as SearchFilter, button]),
);
const documentOption = scopeSelect.querySelector<HTMLOptionElement>('option[value="document"]') as HTMLOptionElement;

/** The tab the user chose. A `t:` style prefix highlights another one without changing this. */
let chosenFilter: SearchFilter = 'all';
let hits: SearchHit[] = [];
let selectedIndex = -1;
let seq = 0;
let renderedSeq = 0;
let queryTimer: number | undefined;
let previewTimer: number | undefined;
let indexing = false;

function span(className: string, text?: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/* ---------------------------------- Search ---------------------------------- */

function currentQuery(): QueryState {
  return { text: input.value, filter: chosenFilter, scope: scopeSelect.value as SearchScope };
}

function sendQuery(): void {
  clearTimeout(queryTimer);
  vscode.postMessage({ type: 'query', seq: ++seq, query: currentQuery() });
}

function scheduleQuery(): void {
  clearTimeout(queryTimer);
  queryTimer = window.setTimeout(sendQuery, QUERY_DEBOUNCE_MS);
}

function highlightTab(filter: SearchFilter): void {
  for (const [value, button] of tabButtons) {
    const active = value === filter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
}

function renderCounts(counts: FilterCounts): void {
  for (const [value, button] of tabButtons) {
    const label = button.querySelector('.count') as HTMLElement;
    label.textContent = input.value.trim() ? counts[value].toLocaleString() : '';
  }
}

function renderName(hit: SearchHit): HTMLElement {
  const name = span('name');
  const matched = new Set(hit.positions);
  let run = '';
  let runMatched = false;
  const flush = () => {
    if (run) {
      name.append(runMatched ? span('hl', run) : run);
    }
    run = '';
  };
  for (let index = 0; index < hit.name.length; index++) {
    const isMatched = matched.has(index);
    if (isMatched !== runMatched) {
      flush();
      runMatched = isMatched;
    }
    run += hit.name[index];
  }
  flush();
  return name;
}

function renderRow(hit: SearchHit, index: number): HTMLElement {
  const style = KIND_STYLES[hit.kind];
  const row = document.createElement('div');
  row.className = 'row';
  row.id = `hit-${index}`;
  row.setAttribute('role', 'option');
  row.dataset.index = String(index);

  const icon = document.createElement('i');
  icon.className = `codicon codicon-${style.icon}`;
  icon.style.color = `var(--vscode-symbolIcon-${style.color}Foreground)`;
  icon.title = style.label;

  const location = hit.kind === 'file' ? hit.relPath : `${hit.relPath}:${hit.line + 1}`;
  row.append(icon, renderName(hit), span('detail', hit.detail));
  row.append(span('container', hit.kind === 'file' ? '' : hit.container), span('location', location));
  row.title = `${style.label}: ${[hit.container, hit.name].filter(Boolean).join('.')}${hit.detail}\n${location}`;
  return row;
}

function renderHint(): void {
  const hint = document.createElement('div');
  hint.className = 'hint';
  if (input.value.trim()) {
    hint.textContent = indexing ? 'No results yet. Still indexing…' : 'No results found.';
  } else {
    const prefixes: [string, string][] = [
      ['t:', 'types'],
      ['m:', 'members'],
      ['v:', 'variables'],
      ['f:', 'files'],
    ];
    hint.append('Type a name, CamelCase initials (', span('kbd', 'GUN'), ' finds GetUserName) or ');
    hint.append(span('kbd', 'Class.Member'), '. Filter with ');
    prefixes.forEach(([prefix, label], index) => {
      hint.append(index > 0 ? ', ' : '', span('kbd', prefix), ` ${label}`);
    });
    hint.append('.');
  }
  resultsPane.replaceChildren(hint);
}

function renderResults(next: SearchHit[], refreshed: boolean): void {
  const previousKey = hits[selectedIndex]?.key;
  hits = next;
  if (hits.length === 0) {
    selectedIndex = -1;
    renderHint();
    clearPreview();
    return;
  }
  const fragment = document.createDocumentFragment();
  hits.forEach((hit, index) => fragment.append(renderRow(hit, index)));
  resultsPane.replaceChildren(fragment);
  // A refresh of the same query, as happens during indexing, must not move the selection.
  const kept = refreshed ? hits.findIndex((hit) => hit.key === previousKey) : -1;
  select(Math.max(kept, 0), kept < 0);
}

function select(index: number, scrollToTop = false): void {
  resultsPane.querySelector('.row.selected')?.classList.remove('selected');
  selectedIndex = Math.min(Math.max(index, 0), hits.length - 1);
  const row = element(`hit-${selectedIndex}`);
  row.classList.add('selected');
  row.setAttribute('aria-selected', 'true');
  input.setAttribute('aria-activedescendant', row.id);
  if (scrollToTop) {
    resultsPane.scrollTop = 0;
  } else {
    row.scrollIntoView({ block: 'nearest' });
  }
  schedulePreview();
}

function locationOf(hit: SearchHit): SourceLocation {
  return { file: hit.file, line: hit.line, column: hit.column, length: hit.kind === 'file' ? 0 : hit.name.length };
}

function openSelected(beside: boolean): void {
  const hit = hits[selectedIndex];
  if (hit) {
    vscode.postMessage({ type: 'open', location: locationOf(hit), beside });
  }
}

/* ---------------------------------- Preview --------------------------------- */

interface CachedSource {
  relPath: string;
  source?: HighlightedSource;
  /** Length of the longest line, with tabs expanded. */
  columns: number;
}

const sources = new Map<string, CachedSource>();
let shown: { source: HighlightedSource; target?: SourceLocation } | undefined;
let lineHeight = 18;

function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(showSelectedPreview, PREVIEW_DEBOUNCE_MS);
}

function showSelectedPreview(): void {
  const hit = hits[selectedIndex];
  if (!hit) {
    return;
  }
  const cached = sources.get(hit.file);
  if (cached) {
    // Re-inserting keeps the map in least recently used order.
    sources.delete(hit.file);
    sources.set(hit.file, cached);
    renderPreview(hit, cached);
  } else {
    vscode.postMessage({ type: 'preview', file: hit.file });
  }
}

function clearPreview(): void {
  shown = undefined;
  previewHeader.replaceChildren();
  codeSizer.style.height = '0';
  codeLines.replaceChildren();
}

function measureLineHeight(): void {
  const fontSize = parseFloat(getComputedStyle(codePane).fontSize) || 13;
  lineHeight = Math.round(fontSize * 1.5);
  document.documentElement.style.setProperty('--line-height', `${lineHeight}px`);
}

function renderPreview(hit: SearchHit, cached: CachedSource): void {
  const header = span('path', cached.relPath);
  if (!cached.source) {
    clearPreview();
    previewHeader.append(header, span('position', 'File could not be read'));
    return;
  }
  const position = hit.kind === 'file' ? '' : `Ln ${hit.line + 1}, Col ${hit.column + 1}`;
  previewHeader.replaceChildren(header, span('position', position));

  const target = hit.kind === 'file' ? undefined : locationOf(hit);
  shown = { source: cached.source, target };
  measureLineHeight();
  const gutter = String(cached.source.lines.length).length + 2;
  codeSizer.style.height = `${cached.source.lines.length * lineHeight}px`;
  codeSizer.style.width = `calc(${gutter + cached.columns + 2}ch + 16px)`;
  codeSizer.style.setProperty('--gutter', `${gutter}ch`);

  const line = target?.line ?? 0;
  codePane.scrollTop = Math.max(0, line * lineHeight - codePane.clientHeight / 3);
  codePane.scrollLeft = 0;
  renderVisibleLines();
}

function appendRun(parent: HTMLElement, text: string, tokenClass: number, marked: boolean): void {
  if (text.length === 0) {
    return;
  }
  const classes = [tokenClass > 0 ? `t-${TOKEN_CLASSES[tokenClass]}` : '', marked ? 'match' : ''];
  const className = classes.filter(Boolean).join(' ');
  parent.append(className ? span(className, text) : text);
}

/** Appends `text`, marking the part that falls inside the target's range. */
function appendSplit(parent: HTMLElement, line: string, start: number, end: number, tokenClass: number, mark?: [number, number]): void {
  if (!mark || end <= mark[0] || start >= mark[1]) {
    appendRun(parent, line.slice(start, end), tokenClass, false);
    return;
  }
  const markStart = Math.max(start, mark[0]);
  const markEnd = Math.min(end, mark[1]);
  appendRun(parent, line.slice(start, markStart), tokenClass, false);
  appendRun(parent, line.slice(markStart, markEnd), tokenClass, true);
  appendRun(parent, line.slice(markEnd, end), tokenClass, false);
}

function renderLine(source: HighlightedSource, index: number, target: SourceLocation | undefined): HTMLElement {
  const row = document.createElement('div');
  row.className = 'line';
  const isTarget = target?.line === index;
  row.classList.toggle('current', isTarget);
  const code = span('src');
  row.append(span('ln', String(index + 1)), code);

  const line = source.lines[index];
  const spans = source.spans[index];
  const mark: [number, number] | undefined = isTarget && target ? [target.column, target.column + target.length] : undefined;
  let position = 0;
  for (let i = 0; i < spans.length; i += 3) {
    const start = spans[i];
    const end = start + spans[i + 1];
    appendSplit(code, line, position, start, 0, mark);
    appendSplit(code, line, start, end, spans[i + 2], mark);
    position = end;
  }
  appendSplit(code, line, position, line.length, 0, mark);
  return row;
}

function renderVisibleLines(): void {
  if (!shown) {
    return;
  }
  const { source, target } = shown;
  const first = Math.max(0, Math.floor(codePane.scrollTop / lineHeight) - OVERSCAN_LINES);
  const visible = Math.ceil(codePane.clientHeight / lineHeight);
  const last = Math.min(source.lines.length, first + visible + OVERSCAN_LINES * 2);
  const fragment = document.createDocumentFragment();
  for (let index = first; index < last; index++) {
    fragment.append(renderLine(source, index, target));
  }
  codeLines.style.transform = `translateY(${first * lineHeight}px)`;
  codeLines.replaceChildren(fragment);
}

function longestLine(source: HighlightedSource): number {
  let longest = 0;
  for (const line of source.lines) {
    let width = line.length;
    for (let index = line.indexOf('\t'); index >= 0; index = line.indexOf('\t', index + 1)) {
      width += TAB_SIZE - 1;
    }
    longest = Math.max(longest, width);
  }
  return longest;
}

function cacheSource(file: string, relPath: string, source: HighlightedSource | undefined): void {
  sources.delete(file);
  sources.set(file, { relPath, source, columns: source ? longestLine(source) : 0 });
  if (sources.size > MAX_CACHED_SOURCES) {
    const oldest = sources.keys().next().value;
    if (oldest !== undefined) {
      sources.delete(oldest);
    }
  }
}

function invalidateSource(file: string): void {
  if (sources.delete(file) && hits[selectedIndex]?.file === file) {
    schedulePreview();
  }
}

/* --------------------------------- Host events ------------------------------- */

function applyTheme(colors: TokenColors): void {
  const style = document.documentElement.style;
  for (const [tokenClass, color] of Object.entries(colors)) {
    style.setProperty(`--tok-${tokenClass}`, color);
  }
}

function applyDocumentName(name: string | undefined): void {
  documentOption.disabled = !name;
  documentOption.textContent = name ? `Current document (${name})` : 'Current document';
  if (!name && scopeSelect.value === 'document') {
    scopeSelect.value = 'workspace';
  }
}

function focusInput(text?: string): void {
  if (text !== undefined) {
    input.value = text;
    sendQuery();
  }
  input.focus();
}

function applyStatus(message: Extract<HostMessage, { type: 'status' }>): void {
  const wasIndexing = indexing;
  indexing = message.indexing;
  progress.classList.toggle('active', indexing);
  progressBar.style.width = message.total > 0 ? `${(message.indexed / message.total) * 100}%` : '0';
  statusText.textContent = indexing
    ? `Indexing ${message.indexed.toLocaleString()} of ${message.total.toLocaleString()} files…`
    : `${message.indexed.toLocaleString()} files, ${message.symbols.toLocaleString()} symbols`;
  if (wasIndexing !== indexing && hits.length === 0) {
    renderHint();
  }
}

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      input.value = message.query.text;
      chosenFilter = message.query.filter;
      highlightTab(chosenFilter);
      applyDocumentName(message.documentName);
      scopeSelect.value = message.query.scope;
      focusInput();
      input.select();
      if (message.query.text) {
        sendQuery();
      }
      return;
    case 'focus':
      if (message.documentName !== undefined) {
        applyDocumentName(message.documentName);
      }
      focusInput(message.text);
      if (message.selectAll) {
        input.select();
      }
      return;
    case 'results':
      if (message.seq === seq) {
        highlightTab(message.filter);
        renderCounts(message.counts);
        renderResults(message.items, message.seq === renderedSeq);
        renderedSeq = message.seq;
      }
      return;
    case 'status':
      applyStatus(message);
      return;
    case 'source': {
      cacheSource(message.file, message.relPath, message.source);
      if (hits[selectedIndex]?.file === message.file) {
        showSelectedPreview();
      }
      return;
    }
    case 'invalidate':
      if (message.file) {
        invalidateSource(message.file);
      } else {
        sources.clear();
      }
      return;
    case 'theme':
      applyTheme(message.colors);
      return;
  }
});

/* ------------------------------- User interaction ---------------------------- */

input.addEventListener('input', scheduleQuery);

scopeSelect.addEventListener('change', () => {
  sendQuery();
  input.focus();
});

tabs.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (button) {
    // A clicked tab replaces whatever filter a typed prefix asked for.
    input.value = input.value.replace(/^\s*[tmvf]:\s*/i, '');
    chosenFilter = button.dataset.filter as SearchFilter;
    highlightTab(chosenFilter);
    sendQuery();
    input.focus();
  }
});

resultsPane.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.row');
  if (row) {
    select(Number(row.dataset.index));
    input.focus();
  }
});

resultsPane.addEventListener('dblclick', (event) => {
  if ((event.target as HTMLElement).closest('.row')) {
    openSelected(event.ctrlKey || event.metaKey);
  }
});

document.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowUp':
    case 'PageDown':
    case 'PageUp': {
      if (hits.length === 0 || document.activeElement === scopeSelect) {
        return;
      }
      const step = event.key.startsWith('Page') ? PAGE_ROWS : 1;
      const direction = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : -1;
      select(selectedIndex + direction * step);
      event.preventDefault();
      return;
    }
    case 'Enter':
      if (document.activeElement === input) {
        openSelected(event.ctrlKey || event.metaKey);
        event.preventDefault();
      }
      return;
    case 'Escape':
      vscode.postMessage({ type: 'close' });
      return;
  }
});

codePane.addEventListener('scroll', () => requestAnimationFrame(renderVisibleLines), { passive: true });
new ResizeObserver(renderVisibleLines).observe(codePane);

/* Splitter */

function setPreviewHeight(height: number): void {
  const available = app.clientHeight - resultsPane.offsetTop;
  const clamped = Math.min(Math.max(height, MIN_PANE_HEIGHT), Math.max(available - MIN_PANE_HEIGHT, MIN_PANE_HEIGHT));
  document.documentElement.style.setProperty('--preview-height', `${clamped}px`);
}

splitter.addEventListener('pointerdown', (event) => {
  splitter.setPointerCapture(event.pointerId);
  splitter.classList.add('dragging');
});

splitter.addEventListener('pointermove', (event) => {
  if (splitter.hasPointerCapture(event.pointerId)) {
    setPreviewHeight(app.clientHeight - event.clientY);
  }
});

splitter.addEventListener('pointerup', (event) => {
  splitter.releasePointerCapture(event.pointerId);
  splitter.classList.remove('dragging');
  vscode.setState({ previewHeight: app.clientHeight - event.clientY });
});

const persisted = vscode.getState();
if (persisted?.previewHeight) {
  setPreviewHeight(persisted.previewHeight);
}

highlightTab(chosenFilter);
renderHint();
vscode.postMessage({ type: 'ready' });
