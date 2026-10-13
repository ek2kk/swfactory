import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile as nativeExecFile, spawn as nativeSpawn, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Each task owns isolated POSIX process groups, including descendants after the leader exits.
const context = new AsyncLocalStorage<ProcessScope>();
export class ProcessScope {
  constructor(private onProcess: (pid: number) => void = () => {}) {}
  readonly controller = new AbortController();
  private cancelled = false;
  private scanning = false;
  private groups = new Set<number>();
  private jobs = new Set<Promise<unknown>>();
  run<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    const job = context.run(this, async () => {
      try { return await work(); }
      finally {
        // Keep the scheduler slot while deletion is stopping descendant processes.
        while ((this.cancelled || this.controller.signal.aborted) && (this.scanning || !this.knownGroupsStopped())) await delay(25);
      }
    });
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }
  // shortcut: ps cannot recover orphan ancestry; deletion also requires persisted human reconciliation.
  knownGroupsStopped() { return [...this.groups].every(pid => !this.alive(pid)); }
  check() { if (this.cancelled) throw new Error('Task execution aborted'); this.controller.signal.throwIfAborted(); }
  track(child: ChildProcess) {
    if (!child.pid) return;
    this.groups.add(child.pid);
    try { this.onProcess(child.pid); }
    catch (error) { process.kill(-child.pid, 'SIGKILL'); throw error; }
  }
  private alive(pid: number) {
    try { process.kill(-pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') { this.groups.delete(pid); return false; }
      if (code === 'EPERM') return true; // Inaccessible is not proof of termination.
      throw error;
    }
  }
  private signal(signal: NodeJS.Signals) {
    for (const pid of this.groups) if (this.alive(pid)) {
      try { process.kill(-pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  private async discoverDescendantGroups() {
    if (!this.groups.size) return;
    const listing = await new Promise<string>((resolve, reject) => {
      // Read-only OS census; do not add the census process to the task being stopped.
      nativeExecFile('ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const rows = listing.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    if (rows.some(row => row.length !== 3 || row.some(id => !Number.isSafeInteger(id) || id < 0))) throw new Error('Не удалось проверить дерево процессов. Нужна ручная сверка.');
    const owned = new Set(rows.filter(row => this.groups.has(row[2])).map(row => row[0]));
    let added: boolean;
    do {
      added = false;
      for (const [pid, parent, group] of rows) if (owned.has(parent) && !owned.has(pid)) {
        owned.add(pid); added = true;
        if (!this.groups.has(group)) { this.groups.add(group); this.onProcess(group); }
      }
    } while (added);
  }
  async stop(timeout = 5000) {
    this.cancelled = true;
    this.scanning = true;
    if (!this.groups.size) this.controller.abort();
    try { await this.discoverDescendantGroups(); }
    finally { this.scanning = false; }
    this.controller.abort();
    const deadline = Date.now() + timeout;
    this.signal('SIGTERM');
    while (true) {
      const alive = [...this.groups].some(pid => this.alive(pid));
      if (!alive && !this.jobs.size) return;
      if (Date.now() >= deadline) throw new Error('Остановка процессов или callbacks не подтверждена. Повторите удаление; нужна ручная сверка.');
      await this.discoverDescendantGroups();
      if (Date.now() > deadline - timeout + 500) this.signal('SIGKILL');
      await delay(25);
    }
  }
}
export function checkExecution() { context.getStore()?.check(); }
export function executionSignal() { return context.getStore()?.controller.signal; }

export const execFile: typeof nativeExecFile = ((file: string, args: string[], options: ExecFileOptions, callback?: (...args: any[]) => void) => {
  const scope = context.getStore(); scope?.check();
  if (!scope) return nativeExecFile(file, args, options, callback as any);
  // execFile itself does not forward detached to spawn; buffer an isolated spawn instead.
  const child = nativeSpawn(file, args, { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  scope.track(child);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0, error: Error | undefined;
  const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* close/error records failure */ } } };
  const timer = options.timeout ? setTimeout(() => { error = new Error('Command timeout'); stop(); }, options.timeout) : undefined;
  const collect = (output: Buffer[]) => (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > (options.maxBuffer ?? 1024 * 1024)) { error = new Error('Command output limit'); stop(); }
    else output.push(chunk);
  };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  child.on('error', value => { error = value; });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0 || signal) error ??= Object.assign(new Error('Command failed'), { code, signal });
    const decode = (chunks: Buffer[]) => options.encoding === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString((options.encoding ?? 'utf8') as BufferEncoding);
    callback?.(error ?? null, decode(stdout), decode(stderr));
  });
  return child;
}) as typeof nativeExecFile;
export const spawn: typeof nativeSpawn = ((file: string, args: string[], options: object) => {
  const scope = context.getStore(); scope?.check();
  const child = nativeSpawn(file, args, { ...options, detached: true });
  scope?.track(child); return child;
}) as typeof nativeSpawn;
export function exec(file: string, args: string[], options: ExecFileOptions): Promise<{ stdout: any; stderr: any }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
}
