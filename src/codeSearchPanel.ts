import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { HostMessage, QueryState, SourceLocation, WebviewMessage } from './shared/protocol';
import { search } from './shared/search';
import { readSource, SymbolIndex } from './symbolIndex';
import { resolveTokenColors } from './theme';
import type { WorkerPool } from './workerPool';

const VIEW_TYPE = 'csharpCodeSearch';
const REFRESH_THROTTLE_MS = 200;
const DEFAULT_MAX_RESULTS = 200;

export interface PanelDependencies {
  distUri: vscode.Uri;
  index: SymbolIndex;
  pool: WorkerPool;
}

/** Selected single-line text seeds the search, like Visual Studio. */
function selectedText(editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor || editor.selection.isEmpty || !editor.selection.isSingleLine) {
    return undefined;
  }
  return editor.document.getText(editor.selection).trim() || undefined;
}

function activeCSharpFile(editor: vscode.TextEditor | undefined): string | undefined {
  const document = editor?.document;
  return document?.languageId === 'csharp' && document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
}

export class CodeSearchPanel {
  private static current: CodeSearchPanel | undefined;
  /** Survives closing the panel, so reopening it resumes the last search. */
  private static lastQuery: QueryState = { text: '', filter: 'all', scope: 'workspace' };

  private readonly disposables: vscode.Disposable[] = [];
  private activeDocument: string | undefined;
  private query: QueryState;
  private seq = 0;
  private refreshTimer: NodeJS.Timeout | undefined;

  static show(dependencies: PanelDependencies): void {
    const editor = vscode.window.activeTextEditor;
    if (CodeSearchPanel.current) {
      CodeSearchPanel.current.reveal(editor);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'C# Code Search',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [dependencies.distUri],
      },
    );
    CodeSearchPanel.current = new CodeSearchPanel(panel, dependencies, editor);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly dependencies: PanelDependencies,
    editor: vscode.TextEditor | undefined,
  ) {
    this.activeDocument = activeCSharpFile(editor);
    this.query = { ...CodeSearchPanel.lastQuery, text: selectedText(editor) ?? CodeSearchPanel.lastQuery.text };
    if (!this.activeDocument) {
      this.query.scope = 'workspace';
    }
    panel.webview.html = this.renderHtml();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(({ webviewPanel }) => {
        if (webviewPanel.active) {
          this.post({ type: 'focus' });
        }
      }),
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message)),
      dependencies.index.onDidChange((file) => this.onIndexChange(file)),
      vscode.window.onDidChangeActiveColorTheme(() => void this.postTheme()),
    );
  }

  private reveal(editor: vscode.TextEditor | undefined): void {
    this.panel.reveal(undefined, false);
    // The active editor is undefined when the shortcut is pressed inside the panel itself.
    if (editor) {
      this.activeDocument = activeCSharpFile(editor);
    }
    this.post({ type: 'focus', text: selectedText(editor), documentName: this.documentName(), selectAll: true });
  }

  private documentName(): string | undefined {
    return this.activeDocument && path.basename(this.activeDocument);
  }

  private post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async postTheme(): Promise<void> {
    this.post({ type: 'theme', colors: await resolveTokenColors() });
  }

  private onMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'ready':
        this.post({ type: 'init', query: this.query, documentName: this.documentName() });
        this.post({ type: 'status', ...this.dependencies.index.status });
        void this.postTheme();
        return;
      case 'query':
        this.seq = message.seq;
        this.query = message.query;
        CodeSearchPanel.lastQuery = message.query;
        this.runSearch();
        return;
      case 'preview':
        void this.postSource(message.file);
        return;
      case 'open':
        void this.open(message.location, message.beside);
        return;
      case 'close':
        this.panel.dispose();
        return;
    }
  }

  private runSearch(): void {
    const limit = vscode.workspace.getConfiguration('csharpCodeSearch').get('maxResults', DEFAULT_MAX_RESULTS);
    const file = this.query.scope === 'document' ? this.activeDocument : undefined;
    const response = search(this.dependencies.index.files.values(), this.query.text, {
      filter: this.query.filter,
      limit,
      file,
    });
    this.post({ type: 'results', seq: this.seq, ...response });
  }

  private async postSource(file: string): Promise<void> {
    const { index, pool } = this.dependencies;
    const relPath = index.files.get(file)?.relPath ?? vscode.workspace.asRelativePath(file);
    try {
      this.post({ type: 'source', file, relPath, source: await pool.highlight(await readSource(file)) });
    } catch {
      this.post({ type: 'source', file, relPath });
    }
  }

  private async open(location: SourceLocation, beside: boolean): Promise<void> {
    const start = new vscode.Position(location.line, location.column);
    const range = new vscode.Range(start, start.translate(0, location.length));
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(location.file), {
      selection: range,
      viewColumn: beside ? vscode.ViewColumn.Beside : this.panel.viewColumn,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!beside) {
      this.panel.dispose();
    }
  }

  private onIndexChange(file: string | undefined): void {
    if (file) {
      this.post({ type: 'invalidate', file });
    }
    // Indexing reports every file, so refreshes are limited to a steady rate.
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined;
      this.post({ type: 'status', ...this.dependencies.index.status });
      if (this.query.text.length > 0) {
        this.runSearch();
      }
    }, REFRESH_THROTTLE_MS);
  }

  private renderHtml(): string {
    const { webview } = this.panel;
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.dependencies.distUri, name));
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="${asset('codicon.css')}">
  <link rel="stylesheet" href="${asset('webview.css')}">
  <title>C# Code Search</title>
</head>
<body>
  <div id="app">
    <header>
      <div class="search-row">
        <i class="codicon codicon-search" aria-hidden="true"></i>
        <input id="query" type="text" spellcheck="false" autocomplete="off"
          placeholder="Search types, members and variables" aria-label="Search C# code"
          role="combobox" aria-expanded="true" aria-controls="results">
      </div>
      <div class="filter-row">
        <div id="tabs" role="tablist" aria-label="Filter results">
          <button role="tab" data-filter="all"><span>All</span><span class="count"></span></button>
          <button role="tab" data-filter="types"><span>Types</span><span class="count"></span></button>
          <button role="tab" data-filter="members"><span>Members</span><span class="count"></span></button>
          <button role="tab" data-filter="variables"><span>Variables</span><span class="count"></span></button>
          <button role="tab" data-filter="files"><span>Files</span><span class="count"></span></button>
        </div>
        <span id="status" role="status"></span>
        <select id="scope" aria-label="Search scope">
          <option value="workspace">Entire workspace</option>
          <option value="document">Current document</option>
        </select>
      </div>
      <div id="progress"><div id="progress-bar"></div></div>
    </header>
    <div id="results" role="listbox" aria-label="Search results"></div>
    <div id="splitter" role="separator" aria-orientation="horizontal"></div>
    <section id="preview" aria-label="Code preview">
      <div id="preview-header"></div>
      <div id="code" tabindex="-1"><div id="code-sizer"><div id="code-lines"></div></div></div>
    </section>
  </div>
  <script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    CodeSearchPanel.current = undefined;
    clearTimeout(this.refreshTimer);
    vscode.Disposable.from(...this.disposables).dispose();
  }
}
