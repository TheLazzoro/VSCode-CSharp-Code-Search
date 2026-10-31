import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeSearchPanel } from './codeSearchPanel';
import { SymbolIndex } from './symbolIndex';
import { WorkerPool } from './workerPool';

export interface CodeSearchApi {
  index: SymbolIndex;
}

export function activate(context: vscode.ExtensionContext): CodeSearchApi {
  const distUri = vscode.Uri.joinPath(context.extensionUri, 'dist');
  const pool = new WorkerPool(path.join(context.extensionPath, 'dist'));
  const index = new SymbolIndex(pool);

  context.subscriptions.push(
    pool,
    index,
    vscode.commands.registerCommand('csharpCodeSearch.open', () => {
      index.start();
      CodeSearchPanel.show({ distUri, index, pool });
    }),
    vscode.commands.registerCommand('csharpCodeSearch.rebuildIndex', async () => {
      index.start();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Rebuilding C# Code Search index' },
        () => index.rebuild(),
      );
    }),
  );

  return { index };
}

export function deactivate(): void {}
