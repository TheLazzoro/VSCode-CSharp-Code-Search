import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
import { CSharpEngine } from './engine';
import type { CodeSymbol, HighlightedSource } from '../shared/symbols';

export type WorkerRequest =
  | { type: 'parse'; path: string; text?: string }
  | { type: 'highlight'; text: string };

export type WorkerResponse =
  | { ok: true; symbols?: CodeSymbol[]; source?: HighlightedSource }
  | { ok: false; error: string };

export interface WorkerOptions {
  assetDir: string;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function handle(engine: CSharpEngine, request: WorkerRequest): Promise<WorkerResponse> {
  if (request.type === 'highlight') {
    return { ok: true, source: engine.highlight(request.text) };
  }
  const text = request.text ?? stripBom(await readFile(request.path, 'utf8'));
  return { ok: true, symbols: engine.extractSymbols(text) };
}

const port = parentPort;
if (port) {
  const { assetDir } = workerData as WorkerOptions;
  const engine = CSharpEngine.create(assetDir);
  // Reported per request below. Left unhandled here, it would end the thread first.
  engine.catch(() => undefined);
  port.on('message', (request: WorkerRequest) => {
    engine
      .then((ready) => handle(ready, request))
      .catch((error: unknown): WorkerResponse => ({ ok: false, error: String(error) }))
      .then((response) => port.postMessage(response));
  });
}
