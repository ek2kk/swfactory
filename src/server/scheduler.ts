import type { FastifyBaseLogger } from 'fastify';
import { errorKind } from './logging.js';

type Job = { taskId: string; work: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void;
  enqueued: number; log?: FastifyBaseLogger };

export class Scheduler {
  private active = new Set<string>();
  private pending: Job[] = [];
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastLoad = '';
  private blocked?: string;
  constructor(private available = () => true, private log?: FastifyBaseLogger, private blockedReason = () => 'unavailable') {}
  hasWork(taskId: string) { return this.active.has(taskId) || this.pending.some(job => job.taskId === taskId); }
  cancel(taskId: string) {
    this.pending = this.pending.filter(job => {
      if (job.taskId !== taskId) return true;
      job.log?.info({ event: 'job.cancelled', duration_ms: Date.now() - job.enqueued });
      job.resolve(); return false;
    });
    this.load();
  }
  wake() { clearTimeout(this.timer); this.timer = undefined; this.drain(); }
  close() {
    this.closed = true; clearTimeout(this.timer);
    for (const job of this.pending.splice(0)) {
      job.log?.info({ event: 'job.cancelled', reason: 'shutdown', duration_ms: Date.now() - job.enqueued });
      job.resolve();
    }
    this.load();
  }

  retain(taskId: string, work: () => Promise<void>) {
    if (this.active.has(taskId)) return;
    this.active.add(taskId);
    void work().finally(() => { this.active.delete(taskId); this.drain(); });
  }

  enqueue(taskId: string, work: () => Promise<void>, log = this.log?.child({ task_id: taskId })): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ taskId, work, resolve, reject, enqueued: Date.now(), log });
      log?.info({ event: 'job.enqueued' });
      this.drain();
    });
  }

  private load() {
    const fields = { active: this.active.size, queued: this.pending.length, limit: 3,
      reason: this.closed ? 'shutdown' : this.blocked ?? (this.pending.length
        ? this.active.size >= 3 ? 'capacity' : this.active.has(this.pending[0].taskId) ? 'task_active' : 'available' : 'idle') };
    const signature = JSON.stringify(fields);
    if (signature !== this.lastLoad) { this.lastLoad = signature; this.log?.info({ event: 'scheduler.changed', ...fields }); }
  }

  private drain() {
    if (this.closed) { this.load(); return; }
    if (!this.available()) {
      this.blocked = this.blockedReason();
      this.load();
      if (this.pending.length && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, 250);
      return;
    }
    this.blocked = undefined;
    while (this.active.size < 3 && this.pending.length && !this.active.has(this.pending[0].taskId)) {
      const job = this.pending.shift()!;
      this.active.add(job.taskId);
      const started = Date.now();
      job.log?.info({ event: 'job.started', queue_wait_ms: started - job.enqueued });
      void (async () => {
        try { await job.work(); job.log?.info({ event: 'job.finished', duration_ms: Date.now() - started }); job.resolve(); }
        catch (error) { job.log?.error({ event: 'job.failed', duration_ms: Date.now() - started, error_kind: errorKind(error) }); job.reject(error); }
        finally { this.active.delete(job.taskId); this.drain(); }
      })();
    }
    this.load();
  }
}
