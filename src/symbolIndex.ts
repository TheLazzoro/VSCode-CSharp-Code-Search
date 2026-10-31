import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { IndexedFile, IndexedSymbol } from './shared/search';
import type { CodeSymbol } from './shared/symbols';
import type { WorkerPool } from './workerPool';

const INCLUDE_GLOB = '**/*.cs';
const EDIT_DEBOUNCE_MS = 500;
const SYNC_DEBOUNCE_MS = 500;

export interface IndexStatus {
  indexing: boolean;
  indexed: number;
  total: number;
  symbols: number;
}

/** Reads a file as the editor sees it, so unsaved edits are searched and previewed. */
export async function readSource(file: string): Promise<string> {
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.scheme === 'file' && doc.uri.fsPath === file);
  if (open) {
    return open.getText();
  }
  const text = await readFile(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function excludeGlob(): string | undefined {
  const own = vscode.workspace.getConfiguration('csharpCodeSearch').get<string[]>('exclude', []);
  const inherited = vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude', {});
  const patterns = [...own, ...Object.keys(inherited).filter((pattern) => inherited[pattern] === true)];
  return patterns.length > 0 ? `{${patterns.join(',')}}` : undefined;
}

function relativePath(uri: vscode.Uri): string {
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return vscode.workspace.asRelativePath(uri, multiRoot).replace(/\\/g, '/');
}

export class SymbolIndex implements vscode.Disposable {
  readonly files = new Map<string, IndexedFile>();

  private readonly changeEmitter = new vscode.EventEmitter<string | undefined>();
  /** Fires with the changed file, or undefined when several changed at once. */
  readonly onDidChange = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [this.changeEmitter];
  private readonly editTimers = new Map<string, NodeJS.Timeout>();
  private readonly strings = new Map<string, string>();
  private syncTimer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  private started = false;
  private total = 0;
  private symbolCount = 0;

  constructor(private readonly pool: WorkerPool) {}

  get status(): IndexStatus {
    return { indexing: this.running !== undefined, indexed: this.files.size, total: this.total, symbols: this.symbolCount };
  }

  /** Builds the index on first use and starts tracking changes. */
  start(): void {
    if (!this.started) {
      this.started = true;
      this.watch();
    }
    void this.sync();
  }

  async rebuild(): Promise<void> {
    this.files.clear();
    this.strings.clear();
    this.symbolCount = 0;
    this.changeEmitter.fire(undefined);
    await this.sync();
  }

  /** Resolves when the index has caught up with the workspace. */
  async whenSynced(): Promise<void> {
    while (this.running) {
      await this.running;
    }
  }

  /** Brings the set of indexed files in line with the workspace. */
  sync(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.scan()
      .catch((error: unknown) => {
        console.error('C# Code Search: indexing failed.', error);
      })
      .finally(() => {
        this.running = undefined;
        this.changeEmitter.fire(undefined);
        if (this.rerun) {
          this.rerun = false;
          void this.sync();
        }
      });
    return this.running;
  }

  private async scan(): Promise<void> {
    const uris = await vscode.workspace.findFiles(INCLUDE_GLOB, excludeGlob());
    const current = new Set(uris.map((uri) => uri.fsPath));
    for (const file of this.files.keys()) {
      if (!current.has(file)) {
        this.remove(file);
      }
    }

    const added = uris.filter((uri) => uri.scheme === 'file' && !this.files.has(uri.fsPath));
    this.total = this.files.size + added.length;
    this.changeEmitter.fire(undefined);
    const outcomes = await Promise.all(added.map((uri) => this.parse(uri)));

    // Single files can vanish mid-scan, but losing every file means the parser itself is broken.
    if (added.length > 0 && outcomes.every((parsed) => !parsed)) {
      void vscode.window.showErrorMessage(
        'C# Code Search could not index any files. See the Developer Tools console for details.',
      );
    }
  }

  private async parse(uri: vscode.Uri, text?: string): Promise<boolean> {
    try {
      this.store(uri, await this.pool.parse(uri.fsPath, text));
      return true;
    } catch (error) {
      console.warn(`C# Code Search: could not index ${uri.fsPath}.`, error);
      this.total = Math.max(0, this.total - 1);
      return false;
    }
  }

  private store(uri: vscode.Uri, symbols: CodeSymbol[]): void {
    const file = uri.fsPath;
    const indexed = symbols.map((symbol) => this.toIndexed(symbol));
    this.symbolCount += indexed.length - (this.files.get(file)?.symbols.length ?? 0);
    this.files.set(file, { path: file, relPath: relativePath(uri), symbols: indexed });
    this.changeEmitter.fire(file);
  }

  private remove(file: string): void {
    this.symbolCount -= this.files.get(file)?.symbols.length ?? 0;
    this.files.delete(file);
    this.changeEmitter.fire(file);
  }

  /** Names, containers and signatures repeat heavily, and large workspaces hold millions. */
  private intern(value: string): string {
    const existing = this.strings.get(value);
    if (existing !== undefined) {
      return existing;
    }
    this.strings.set(value, value);
    return value;
  }

  private toIndexed(symbol: CodeSymbol): IndexedSymbol {
    return {
      ...symbol,
      name: this.intern(symbol.name),
      nameLower: this.intern(symbol.name.toLowerCase()),
      container: this.intern(symbol.container),
      detail: this.intern(symbol.detail),
    };
  }

  private watch(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(INCLUDE_GLOB);
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.scheduleSync()),
      watcher.onDidChange((uri) => this.reparseIfIndexed(uri)),
      watcher.onDidDelete((uri) => {
        if (this.files.has(uri.fsPath)) {
          this.remove(uri.fsPath);
        }
      }),
      // The watcher glob misses folder deletes and renames.
      vscode.workspace.onDidDeleteFiles(() => this.scheduleSync()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleSync()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleSync()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('csharpCodeSearch.exclude') || event.affectsConfiguration('files.exclude')) {
          this.scheduleSync();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId === 'csharp' && event.contentChanges.length > 0) {
          this.scheduleEdit(event.document.uri);
        }
      }),
      // Closing a dirty document discards the edits that were indexed.
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.languageId === 'csharp') {
          this.scheduleEdit(document.uri);
        }
      }),
    );
  }

  private scheduleSync(): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.sync(), SYNC_DEBOUNCE_MS);
  }

  private scheduleEdit(uri: vscode.Uri): void {
    const file = uri.fsPath;
    clearTimeout(this.editTimers.get(file));
    this.editTimers.set(
      file,
      setTimeout(() => {
        this.editTimers.delete(file);
        this.reparseIfIndexed(uri);
      }, EDIT_DEBOUNCE_MS),
    );
  }

  private reparseIfIndexed(uri: vscode.Uri): void {
    if (this.files.has(uri.fsPath)) {
      void readSource(uri.fsPath).then(
        (text) => this.parse(uri, text),
        () => this.remove(uri.fsPath),
      );
    }
  }

  dispose(): void {
    clearTimeout(this.syncTimer);
    for (const timer of this.editTimers.values()) {
      clearTimeout(timer);
    }
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
