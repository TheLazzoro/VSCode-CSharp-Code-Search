// Drives the webview in a real VS Code window through the keyboard, as a user would.
// The integration suite cannot reach inside a webview, so its behavior is covered here.
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { _electron as electron } from 'playwright-core';

const SETTLE_MS = 500;
const repo = path.resolve(import.meta.dirname, '../..');
const profile = mkdtempSync(path.join(tmpdir(), 'csharp-code-search-e2e-'));

// Inherited when run from inside VS Code, where it would start Code.exe as plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: await downloadAndUnzipVSCode(),
  env,
  timeout: 60_000,
  args: [
    `--extensionDevelopmentPath=${repo}`,
    `--user-data-dir=${profile}`,
    `--extensions-dir=${path.join(profile, 'extensions')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-updates',
    path.join(repo, 'test/fixtures/sample'),
  ],
});

const page = await app.firstWindow();
const settle = (ms = SETTLE_MS) => page.waitForTimeout(ms);

async function webviewFrame() {
  for (let attempt = 0; attempt < 100; attempt++) {
    for (const frame of page.frames()) {
      if (await frame.$('#query').catch(() => null)) {
        return frame;
      }
    }
    await page.waitForTimeout(100);
  }
  throw new Error('The webview did not open.');
}

async function panelIsOpen() {
  const inputs = await Promise.all(page.frames().map((frame) => frame.$('#query').catch(() => null)));
  return inputs.some(Boolean);
}

/** The title of VS Code's modal overlay, the same one Settings opens in, if it is showing. */
function modalTitle() {
  return page.evaluate(
    () => document.querySelector('.monaco-modal-editor-block [class*="title"]')?.textContent?.replace(/\s+/g, ' ').trim(),
  );
}

async function search(text) {
  await page.keyboard.press('Control+A');
  await settle(100);
  await page.keyboard.type(text, { delay: 20 });
  await settle();
}

function state(frame) {
  return frame.evaluate(() => ({
    value: document.querySelector('#query').value,
    focused: document.activeElement?.id,
    rows: [...document.querySelectorAll('.row .name')].map((name) => name.textContent),
    selected: document.querySelector('.row.selected .name')?.textContent,
    selectedRow: Number(document.querySelector('.row.selected')?.dataset.index),
    tab: document.querySelector('#tabs .active')?.dataset.filter,
    position: document.querySelector('#preview-header .position')?.textContent,
    marked: document.querySelector('.line.current .match')?.textContent,
    tokenColors: new Set(
      [...document.querySelectorAll('#code-lines [class^="t-"]')].map((token) => getComputedStyle(token).color),
    ).size,
  }));
}

async function openFromQuickPick(name) {
  await page.keyboard.press('Control+P');
  await settle();
  await page.keyboard.type(name, { delay: 15 });
  await settle(800);
  await page.keyboard.press('Enter');
  await settle(1500);
}

const checks = [];

async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`  ok  ${name}`);
}

try {
  await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  await settle(3000);
  await openFromQuickPick('InvoiceService.cs');

  await page.keyboard.press('Control+T');
  const frame = await webviewFrame();
  await settle(1200);

  await check('Ctrl+T opens the panel with the input focused', async () => {
    assert.equal((await state(frame)).focused, 'query');
  });

  await check('the panel is a modal dialog, like Settings', async () => {
    assert.equal(await modalTitle(), 'Code SearchC#');
  });

  await check('finds a method by CamelCase initials and previews it', async () => {
    await search('GUTA');
    const result = await state(frame);
    assert.equal(result.selected, 'GetUserTotalAsync');
    assert.equal(result.position, 'Ln 43, Col 32');
    assert.equal(result.marked, 'GetUserTotalAsync');
  });

  await check('colors the preview with the theme', async () => {
    assert.ok((await state(frame)).tokenColors >= 5);
  });

  await check('finds a local variable after non-ASCII text', async () => {
    await search('rødgrød');
    const result = await state(frame);
    assert.equal(result.position, 'Ln 74, Col 23');
    assert.equal(result.marked, 'rødgrød');
  });

  await check('a filter prefix applies only while it is typed', async () => {
    await search('v:total');
    assert.deepEqual(await state(frame).then(({ tab, rows }) => ({ tab, rows })), { tab: 'variables', rows: ['total'] });
    await search('InvoiceService');
    const result = await state(frame);
    assert.equal(result.tab, 'all');
    assert.ok(result.rows.length > 1);
  });

  await check('a new query selects its first result', async () => {
    await page.keyboard.press('ArrowDown');
    await settle(150);
    assert.equal((await state(frame)).selectedRow, 1);
    await search('Invoice');
    assert.equal((await state(frame)).selectedRow, 0);
  });

  await check('tabs filter the results', async () => {
    await frame.click('button[data-filter="files"]');
    await settle();
    assert.deepEqual((await state(frame)).rows, ['InvoiceService.cs']);
    await frame.click('button[data-filter="all"]');
    await settle(200);
  });

  await check('the document scope leaves out other files', async () => {
    await frame.selectOption('#scope', 'document');
    await settle(200);
    await search('HTMLParser');
    assert.deepEqual((await state(frame)).rows, []);
    await frame.selectOption('#scope', 'workspace');
    await settle();
    assert.deepEqual((await state(frame)).rows, ['HTMLParser']);
  });

  await check('Ctrl+T inside the dialog selects the query', async () => {
    await page.keyboard.press('Control+T');
    await settle();
    const selected = await frame.$eval('#query', (input) => input.value.slice(input.selectionStart, input.selectionEnd));
    assert.equal(selected, 'HTMLParser');
  });

  await check('Ctrl+Enter opens the symbol and keeps the dialog', async () => {
    await page.keyboard.press('Control+Enter');
    await settle(1200);
    assert.equal(await panelIsOpen(), true);
    assert.equal((await state(frame)).focused, 'query');
  });

  await check('Enter opens the symbol and closes the panel', async () => {
    await page.keyboard.press('Enter');
    await settle(1200);
    assert.equal(await panelIsOpen(), false);
    assert.equal(await modalTitle(), undefined);
    const selection = await page.$eval('[id="status.editor.selection"]', (item) => item.textContent);
    assert.match(selection, /^Ln 7, Col 41 \(10 selected\)/);
  });

  await check('reopening restores the query, and Escape closes', async () => {
    await page.keyboard.press('Control+T');
    const reopened = await webviewFrame();
    await settle(1000);
    assert.equal(await reopened.$eval('#query', (input) => input.value), 'HTMLParser');
    await page.keyboard.press('Escape');
    await settle(800);
    assert.equal(await panelIsOpen(), false);
  });

  console.log(`\n${checks.length} checks passed.`);
} finally {
  await app.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
