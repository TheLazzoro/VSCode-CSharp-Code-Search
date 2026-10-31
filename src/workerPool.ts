import { availableParallelism } from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Disposable } from 'vscode';
import type { CodeSymbol, HighlightedSource } from './shared/symbols';
import type { WorkerOptions, WorkerRequest, WorkerResponse } from './worker/parseWorker';

const MAX_WORKERS = 4;
const IDLE_SHUTDOWN_MS = 60_000;

interface Task {
  request: WorkerRequest;
  resolve(response: WorkerResponse & { ok: true }): void;
  reject(error: Error): void;
}

/** Runs parsing off the extension host thread. Workers start on demand and stop when idle. */
export class WorkerPool implements Disposable {
  private readonly size = Math.max(1, Math.min(MAX_WORKERS, availableParallelism() - 1));
  private readonly queue: Task[] = [];
  private readonly idle: Worker[] = [];
  private readonly running = new Map<Worker, Task>();
  private idleTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly assetDir: string) {}

  async parse(file: string, text?: string): Promise<CodeSymbol[]> {
    const { symbols } = await this.submit({ type: 'parse', path: file, text });
    return symbols ?? [];
  }

  /** Jumps the queue, so a preview stays responsive during indexing. */
  async highlight(text: string): Promise<HighlightedSource> {
    const { source } = await this.submit({ type: 'highlight', text }, true);
    return source ?? { lines: [], spans: [] };
  }

  private submit(request: WorkerRequest, urgent = false): Promise<WorkerResponse & { ok: true }> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('The worker pool is disposed.'));
        return;
      }
      const task = { request, resolve, reject };
      if (urgent) {
        this.queue.unshift(task);
      } else {
        this.queue.push(task);
      }
      this.dispatch();
    });
  }

  private dispatch(): void {
    clearTimeout(this.idleTimer);
    while (this.queue.length > 0) {
      const worker = this.idle.pop() ?? this.spawn();
      if (!worker) {
        return;
      }
      const task = this.queue.shift();
      if (task) {
        this.running.set(worker, task);
        worker.postMessage(task.request);
      }
    }
    if (this.running.size === 0) {
      this.idleTimer = setTimeout(() => this.stopIdleWorkers(), IDLE_SHUTDOWN_MS);
    }
  }

  private spawn(): Worker | undefined {
    if (this.running.size + this.idle.length >= this.size) {
      return undefined;
    }
    const workerData: WorkerOptions = { assetDir: this.assetDir };
    const worker = new Worker(path.join(this.assetDir, 'parseWorker.js'), { workerData });
    worker.on('message', (response: WorkerResponse) => this.onResponse(worker, response));
    worker.on('error', (error) => this.onFailure(worker, error));
    return worker;
  }

  private onResponse(worker: Worker, response: WorkerResponse): void {
    const task = this.running.get(worker);
    this.running.delete(worker);
    this.idle.push(worker);
    if (response.ok) {
      task?.resolve(response);
    } else {
      task?.reject(new Error(response.error));
    }
    this.dispatch();
  }

  private onFailure(worker: Worker, error: Error): void {
    const task = this.running.get(worker);
    this.running.delete(worker);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) {
      this.idle.splice(idleIndex, 1);
    }
    void worker.terminate();
    task?.reject(error);
    this.dispatch();
  }

  private stopIdleWorkers(): void {
    for (const worker of this.idle.splice(0)) {
      void worker.terminate();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleTimer);
    for (const task of this.queue.splice(0)) {
      task.reject(new Error('The worker pool is disposed.'));
    }
    for (const [worker, task] of this.running) {
      task.reject(new Error('The worker pool is disposed.'));
      void worker.terminate();
    }
    this.running.clear();
    this.stopIdleWorkers();
  }
}
