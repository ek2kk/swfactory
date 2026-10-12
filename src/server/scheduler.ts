type Job = { taskId: string; work: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void };

export class Scheduler {
  private active = new Set<string>();
  private pending: Job[] = [];

  enqueue(taskId: string, work: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ taskId, work, resolve, reject });
      this.drain();
    });
  }

  private drain() {
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
