import type { FastifyBaseLogger } from 'fastify';
import { errorKind } from './logging.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile as nativeExecFile, execFileSync, spawn as nativeSpawn, type ChildProcess, type ExecFileOptions } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Each task owns isolated POSIX process groups, including descendants after the leader exits.
type ProcessLog = FastifyBaseLogger | (() => FastifyBaseLogger | undefined);
function resolveLog(log?: ProcessLog) { return typeof log === 'function' ? log() : log; }
export type ExecutionProcess = { pid: number; pgid: number; started_at: string; state: 'running' | 'exited' | 'unknown'; run_id?: string | null };
type ProcessRow = { pid: number; parent: number; pgid: number; started_at: string };
export function processCensus(pid?: number): ProcessRow[] {
  const columns = 'pid=,ppid=,pgid=,stat=,lstart=';
  const listing = execFileSync('ps', pid === undefined ? ['-axo', columns] : ['-p', String(pid), '-o', columns],
    { timeout: 200, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return listing.trim().split('\n').flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!row) throw new Error('Не удалось прочитать идентичность процессов.');
    return row[4].startsWith('Z') ? [] : [{ pid: Number(row[1]), parent: Number(row[2]), pgid: Number(row[3]), started_at: row[5].trim().replace(/\s+/g, ' ') }];
  });
}
const context = new AsyncLocalStorage<{ scope: ProcessScope; log?: ProcessLog; runId?: string }>();
export class ProcessScope {
  constructor(private onProcess: (pid: number, identity: ExecutionProcess) => void = () => {}, private log?: FastifyBaseLogger,
    private authorized = () => true) {}
  readonly controller = new AbortController();
  private cancelled = false;
  private scanning = false;
  private groups = new Map<number, ProcessLog | undefined>();
  private identities = new Map<string, ExecutionProcess>();
  private verified = new Set<number>();
  // A census outage revokes signals without releasing previously confirmed capacity.
  private retained = new Set<number>();
  private closed = new Set<number>();
  private refreshed = 0;
  private jobs = new Map<Promise<unknown>, ProcessLog | undefined>();
  private retry?: ReturnType<typeof setTimeout>;
  private key(row: ExecutionProcess) { return `${row.pid}:${row.started_at}`; }
  private save(row: ExecutionProcess) {
    const previous = this.identities.get(this.key(row));
    this.identities.set(this.key(row), row);
    if (!previous || previous.state !== row.state || previous.pgid !== row.pgid) this.onProcess(row.pid, row);
  }
  restore(rows: ExecutionProcess[]) {
    for (const row of rows) { this.identities.set(this.key(row), row); this.groups.set(row.pgid, this.log); }
    this.refresh();
  }
  run<T>(work: () => Promise<T>, log: ProcessLog | undefined = this.log, runId?: string): Promise<T> {
    this.check();
    const job = context.run({ scope: this, log, runId }, async () => {
      try { return await work(); }
      finally {
        // Card completion never releases the slot of a surviving known process.
        while ((this.cancelled || this.controller.signal.aborted) && (this.scanning || this.hasLiveProcesses())) await delay(50);
      }
    });
    this.jobs.set(job, log);
    void job.finally(() => this.jobs.delete(job)).catch(() => {});
    return job;
  }
  knownGroupsStopped() { this.refresh(); return [...this.identities.values()].every(row => row.state === 'exited'); }
  get hasKnownProcess() { return this.retained.size > 0; }
  get hasPendingWork() { return this.jobs.size > 0 || [...this.identities.values()].some(row => row.state !== 'exited'); }
  hasLiveProcesses() { this.refresh(); return this.hasKnownProcess; }
  hasWork() { return this.jobs.size > 0 || !this.knownGroupsStopped(); }
  check() { if (this.cancelled || !this.authorized()) throw new Error('Task execution aborted'); this.controller.signal.throwIfAborted(); }
  track(child: ChildProcess) {
    if (!child.pid) return;
    const current = context.getStore();
    const currentLog = current?.log ?? this.log;
    const log = resolveLog(currentLog);
    this.groups.set(child.pid, currentLog);
    let identity: ProcessRow | undefined;
    try { identity = processCensus(child.pid).find(row => row.pid === child.pid); } catch { /* Missing identity is unknown, never safe to signal after restart. */ }
    try { this.save({ pid: child.pid, pgid: child.pid, started_at: identity?.started_at ?? '', state: identity ? 'running' : 'unknown', run_id: current?.runId ?? null }); }
    catch (error) { child.kill('SIGKILL'); throw error; }
    if (identity) { this.verified.add(child.pid); this.retained.add(child.pid); }
    const started = Date.now();
    child.once?.('close', (code, signal) => {
      this.closed.add(child.pid!);
      let absent = false;
      try { process.kill(-child.pid!, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (absent) {
        for (const row of this.identities.values()) if (row.pgid === child.pid) this.save({ ...row, state: 'exited' });
        this.groups.delete(child.pid!); this.verified.delete(child.pid!); this.retained.delete(child.pid!);
      } else this.refresh(true);
      log?.info({ event: 'process.exited', pid: child.pid, pgid: child.pid, exit_code: code, signal, duration_ms: Date.now() - started });
    });
    child.once?.('error', error => { log?.error({ event: 'process.failed', error_kind: errorKind(error) }); });
    log?.info({ event: 'process.started', pid: child.pid, pgid: child.pid });
  }
  private refresh(force = false) {
    if (!this.groups.size || (!force && Date.now() - this.refreshed < 30)) return;
    this.refreshed = Date.now();
    let rows: ProcessRow[];
    this.verified.clear();
    try { rows = processCensus(); }
    catch {
      for (const row of this.identities.values()) if (row.state !== 'exited') this.save({ ...row, state: 'unknown' });
      return;
    }
    const owned = new Map<number, ExecutionProcess>();
    for (const row of this.identities.values()) {
      if (row.state === 'exited') continue;
      const match = rows.find(candidate => candidate.pid === row.pid && candidate.started_at === row.started_at);
      if (row.started_at && match) {
        const identity = { ...row, pgid: match.pgid };
        this.groups.set(match.pgid, this.groups.get(row.pgid));
        owned.set(row.pid, identity); this.verified.add(match.pgid); this.save(identity);
      }
    }
    let added: boolean;
    do {
      added = false;
      for (const row of rows) if (!owned.has(row.pid)) {
        const owner = owned.get(row.parent) ?? [...owned.values()].find(owner => owner.pgid === row.pgid);
        if (!owner) continue;
        const identity: ExecutionProcess = { ...row, state: 'running', run_id: owner.run_id };
        owned.set(row.pid, identity); this.verified.add(row.pgid);
        this.groups.set(row.pgid, this.groups.get(owner.pgid)); this.save(identity); added = true;
      }
    } while (added);
    this.retained = new Set(this.verified);
    for (const row of this.identities.values()) {
      if (row.state === 'exited') continue;
      const group = rows.some(candidate => candidate.pgid === row.pgid);
      // A reused PID/PGID is unknown, not proof that the former execution ended.
      this.save({ ...row, state: this.verified.has(row.pgid) ? 'running' : !group && (row.started_at || this.closed.has(row.pid)) ? 'exited' : 'unknown' });
    }
    for (const pgid of this.groups.keys()) if (![...this.identities.values()].some(row => row.pgid === pgid && row.state !== 'exited')) this.groups.delete(pgid);
  }
  private signal(signal: NodeJS.Signals) {
    this.refresh(true);
    for (const pid of this.verified) {
      try { process.kill(-pid, signal); resolveLog(this.groups.get(pid))?.info({ event: 'process.signal-sent', pgid: pid, signal }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  }
  private continueStop() {
    if (this.retry || !this.hasKnownProcess) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      try { this.signal('SIGKILL'); } catch { /* Retry known survivors without claiming termination. */ }
      this.continueStop();
    }, 250);
    this.retry.unref();
  }
  async stop(timeout = 4000) {
    const started = Date.now(), deadline = started + timeout;
    const owners = new Set([...this.groups.values(), ...this.jobs.values(), this.log]);
    for (const log of owners) resolveLog(log)?.info({ event: 'process.stop-requested' });
    this.cancelled = true;
    if (timeout <= 0) { this.controller.abort(); this.continueStop(); throw new Error('Общий срок остановки истёк. Повторите остановку для проверки оставшегося исполнения.'); }
    this.scanning = true;
    try {
      this.refresh();
      this.controller.abort();
      this.signal('SIGTERM');
      this.scanning = false;
      while (Date.now() < deadline) {
        if (this.knownGroupsStopped() && !this.jobs.size) {
          for (const log of owners) resolveLog(log)?.info({ event: 'process.stop-confirmed', duration_ms: Date.now() - started, execution_finished: true });
          return;
        }
        if (!this.hasLiveProcesses() && !this.jobs.size) break;
        if (Date.now() - started >= 500) this.signal('SIGKILL');
        await delay(50);
      }
      throw new Error(this.hasLiveProcesses() && this.verified.size ? 'Известный процесс ещё работает. Остановка продолжится; можно повторить её.'
        : 'Завершение исполнения не подтверждено: диагностика процесса или callback недоступна.');
    } catch (error) {
      this.controller.abort();
      for (const log of owners) resolveLog(log)?.warn({ event: 'process.stop-unknown', duration_ms: Date.now() - started, execution_finished: false });
      throw error;
    } finally { this.scanning = false; this.continueStop(); }
  }
}
export function checkExecution() { context.getStore()?.scope.check(); }
export function executionSignal() { return context.getStore()?.scope.controller.signal; }

export const execFile: typeof nativeExecFile = ((file: string, args: string[], options: ExecFileOptions, callback?: (...args: any[]) => void) => {
  const scope = context.getStore()?.scope; scope?.check();
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
  const scope = context.getStore()?.scope; scope?.check();
  const child = nativeSpawn(file, args, { ...options, detached: true });
  scope?.track(child); return child;
}) as typeof nativeSpawn;
export function exec(file: string, args: string[], options: ExecFileOptions): Promise<{ stdout: any; stderr: any }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
}
