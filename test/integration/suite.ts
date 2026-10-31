import * as assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import type { CodeSearchApi } from '../../src/extension';
import { search } from '../../src/shared/search';

const WATCHER_TIMEOUT_MS = 10_000;

function workspaceFile(...segments: string[]): string {
  const folder = vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? '';
  return path.join(folder, ...segments);
}

async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + WATCHER_TIMEOUT_MS;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function registerTests(): void {
  suite('C# Code Search', () => {
    let api: CodeSearchApi;

    const find = (text: string) => search(api.index.files.values(), text, { filter: 'all', limit: 50 });

    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension<CodeSearchApi>('local.csharp-code-search');
      assert.ok(extension);
      api = await extension.activate();
      await vscode.commands.executeCommand('csharpCodeSearch.open');
      await api.index.whenSynced();
    });

    suiteTeardown(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

    test('opens the search as a webview tab', () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.equal(tab?.label, 'C# Code Search');
      assert.ok(tab?.input instanceof vscode.TabInputWebview);
    });

    test('indexes the workspace in worker threads', () => {
      assert.equal(api.index.status.indexing, false);
      assert.ok(api.index.files.has(workspaceFile('Billing', 'InvoiceService.cs')));
      assert.ok(api.index.status.symbols > 50);
    });

    test('leaves excluded folders out', () => {
      assert.equal(api.index.files.has(workspaceFile('obj', 'Generated.cs')), false);
      assert.equal(find('ShouldNotBeIndexed').items.length, 0);
    });

    test('finds methods and local variables', () => {
      assert.equal(find('GetUserTotalAsync').items[0].kind, 'method');
      assert.equal(find('rødgrød').items[0].kind, 'local');
      assert.equal(find('GUTA').items[0].name, 'GetUserTotalAsync');
    });

    test('picks up new, changed and deleted files', async () => {
      const file = workspaceFile('Added.cs');
      try {
        await writeFile(file, 'class AddedByTest { }');
        await until(() => find('AddedByTest').items.length === 1, 'The new file was not indexed.');

        await writeFile(file, 'class RenamedByTest { }');
        await until(() => find('RenamedByTest').items.length === 1, 'The changed file was not reindexed.');
        assert.equal(find('AddedByTest').items.length, 0);
      } finally {
        await rm(file, { force: true });
      }
      await until(() => find('RenamedByTest').items.length === 0, 'The deleted file stayed in the index.');
    });

    test('searches unsaved edits', async () => {
      const uri = vscode.Uri.file(workspaceFile('Legacy', 'BlockScoped.cs'));
      const editor = await vscode.window.showTextDocument(uri);
      await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'class TypedNotSaved { }\n'));
      await until(() => find('TypedNotSaved').items.length === 1, 'The unsaved edit was not indexed.');

      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await until(() => find('TypedNotSaved').items.length === 0, 'The reverted edit stayed in the index.');
    });

    test('rebuilds on request', async () => {
      const before = api.index.status.symbols;
      await vscode.commands.executeCommand('csharpCodeSearch.rebuildIndex');
      await api.index.whenSynced();
      assert.equal(api.index.status.symbols, before);
    });
  });
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000 });
  mocha.suite.emit('pre-require', globalThis, '', mocha);
  registerTests();
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration tests failed.`));
      } else {
        resolve();
      }
    });
  });
}
