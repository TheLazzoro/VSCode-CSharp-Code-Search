import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerRequest, WorkerResponse } from '../../src/worker/parseWorker';

const root = path.resolve(__dirname, '../..');

let worker: Worker | undefined;

/** Runs the bundle rather than the sources: bundling is what breaks module and path lookups. */
function send(request: WorkerRequest, assetDir = path.join(root, 'dist')): Promise<WorkerResponse> {
  worker = new Worker(path.join(root, 'dist/parseWorker.js'), { workerData: { assetDir } });
  return new Promise((resolve, reject) => {
    worker?.once('message', resolve);
    worker?.once('error', reject);
    worker?.postMessage(request);
  });
}

afterEach(() => worker?.terminate());

describe('bundled worker', () => {
  it('parses a file from disk', async () => {
    const file = path.join(root, 'test/fixtures/sample/Legacy/BlockScoped.cs');
    const response = await send({ type: 'parse', path: file });
    expect(response.ok && response.symbols?.map((symbol) => symbol.name)).toContain('HTMLParser');
  });

  it('prefers supplied text over the file on disk', async () => {
    const response = await send({ type: 'parse', path: 'missing.cs', text: 'class FromMemory { }' });
    expect(response.ok && response.symbols?.[0].name).toBe('FromMemory');
  });

  it('highlights text', async () => {
    const response = await send({ type: 'highlight', text: 'class A { }' });
    expect(response.ok && response.source?.lines).toEqual(['class A { }']);
  });

  it('reports files it cannot read', async () => {
    const response = await send({ type: 'parse', path: path.join(root, 'missing.cs') });
    expect(response.ok).toBe(false);
  });

  it('reports a failed startup instead of crashing', async () => {
    const response = await send({ type: 'parse', path: 'any.cs', text: '' }, path.join(root, 'missing-assets'));
    expect(response.ok).toBe(false);
  });
});
