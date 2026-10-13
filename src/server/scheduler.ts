type Job = { taskId: string; work: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void };

export class Scheduler {
  private active = new Set<string>();
  private pending: Job[] = [];
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private available = () => true) {}
  cancel(taskId: string) {
    this.pending = this.pending.filter(job => { if (job.taskId !== taskId) return true; job.resolve(); return false; });
  }
  wake() { clearTimeout(this.timer); this.timer = undefined; this.drain(); }
  close() { this.closed = true; clearTimeout(this.timer); for (const job of this.pending.splice(0)) job.resolve(); }


  enqueue(taskId: string, work: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ taskId, work, resolve, reject });
      this.drain();
    });
  }

  private drain() {
    if (this.closed) return;
    if (!this.available()) {
      if (this.pending.length && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.drain(); }, 250);
      return;
    }
    while (this.active.size < 3 && this.pending.length && !this.active.has(this.pending[0].taskId)) {
      const job = this.pending.shift()!;
      this.active.add(job.taskId);
      void (async () => {
        try { await job.work(); job.resolve(); }
        catch (error) { job.reject(error); }
        finally { this.active.delete(job.taskId); this.drain(); }
      })();
    }
  }
}
