import { classifyOutcome } from './outcome.js';

// Calls stay outside model context. Reused outcomes keep the original call ID.
export class Scheduler {
  constructor({ concurrency = 4, maxQueued = 128, ttlMs = 30000, deadlineMs = 120000 } = {}) {
    Object.assign(this, { concurrency, maxQueued, ttlMs, deadlineMs });
    this.active = 0;
    this.pending = [];
    this.inflight = new Map();
    this.cache = new Map();
    this.epoch = 0;
    this.metrics = this.emptyMetrics();
  }
  emptyMetrics() { return { submitted: 0, reused: 0, completed: 0, queueMs: 0, executionMs: 0 }; }
  reset() {
    this.epoch++;
    for (const job of this.pending.splice(0)) job.reject(new Error('Queued operation cancelled by session/turn change'));
    this.inflight.clear();
    this.cache.clear();
    this.metrics = this.emptyMetrics();
  }
  reusable(value) { return value && typeof value === 'object' ? { ...value, cacheReused: true } : value; }
  submit(key, run, { cacheable = false, coalesce = cacheable, refresh = false, signal } = {}) {
    if (signal?.aborted) return Promise.reject(new Error('Operation cancelled'));
    if ((cacheable || coalesce) && !refresh) {
      if (this.inflight.has(key)) {
        this.metrics.reused++;
        return this.inflight.get(key).then(value => {
          if (signal?.aborted) throw new Error('Operation cancelled');
          return this.reusable(value);
        });
      }
      const old = cacheable ? this.cache.get(key) : null;
      if (old && Date.now() - old.at < this.ttlMs) {
        this.metrics.reused++;
        return Promise.resolve(this.reusable(old.value));
      }
    }
    if (this.pending.length >= this.maxQueued) return Promise.reject(new Error('Execution queue full; wait for submitted work'));
    this.metrics.submitted++;
    const epoch = this.epoch;
    const task = new Promise((resolve, reject) => {
      this.pending.push({ run, resolve, reject, queued: Date.now(), signal, key, cacheable, epoch });
      this.drain();
    });
    if (cacheable || coalesce) this.inflight.set(key, task);
    task.finally(() => { if (this.inflight.get(key) === task) this.inflight.delete(key); }).catch(() => {});
    return task;
  }
  drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      if (job.signal?.aborted || job.epoch !== this.epoch) {
        job.reject(new Error('Operation cancelled'));
        continue;
      }
      if (Date.now() - job.queued > this.deadlineMs) {
        job.reject(new Error('Queued operation deadline exceeded; no execution occurred'));
        continue;
      }
      this.active++;
      const start = Date.now();
      this.metrics.queueMs += start - job.queued;
      Promise.resolve().then(job.run).then(value => {
        if (job.epoch !== this.epoch) {job.reject(new Error('Operation outcome discarded after session/turn change'));return;}
        const result = value?.result ?? value;
        if (job.cacheable && job.epoch === this.epoch && !value?.isError && classifyOutcome(result).usable) {
          this.cache.set(job.key, { at: Date.now(), value });
          if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
        }
        job.resolve(value);
      }, job.reject).finally(() => {
        if (job.epoch === this.epoch) {
          this.metrics.completed++;
          this.metrics.executionMs += Date.now() - start;
        }
        this.active--;
        this.drain();
      });
    }
  }
  snapshot() { return { ...this.metrics, active: this.active, queued: this.pending.length }; }
}
