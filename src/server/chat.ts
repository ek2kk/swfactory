import { randomUUID } from 'node:crypto';
import type { AgentRun, ChatMessage } from '../shared.js';
import { Store, Problem } from './store.js';
import { DeliveryError, type Steer } from './interactive.js';

export class Chat {
  error: string | null = null;
  private controls = new Map<string, { run: AgentRun; steer: Steer }>();
  private deliveries = new Map<string, number>();
  constructor(private store: Store, private publish: () => void) {}
  hasWork(taskId: string) { return this.controls.has(taskId) || !!this.deliveries.get(taskId); }
  cancel(taskId: string) { this.controls.delete(taskId); }
  messages(taskId: string): ChatMessage[] {
    return this.store.db.prepare('SELECT * FROM chat_messages WHERE task_id = ? ORDER BY rowid').all(taskId) as ChatMessage[];
  }
  context(run: AgentRun) {
    return this.messages(run.task_id).filter(m => m.revision === run.description_revision && m.status === 'delivered').map(m => ({ text: m.text, run_id: m.run_id }));
  }
  add(projectId: string, taskId: string, version: number, text: string, kind: ChatMessage['kind']) {
    const task = this.store.task(projectId, taskId);
    if (task.state_version !== version) throw new Problem(409, 'Карточка изменилась. Повторите отправку после обновления.');
    if (!text.trim() || text.length > 4096) throw new Problem(422, 'Сообщение должно содержать от 1 до 4096 символов.');
    if (task.publication_status || task.run_state === 'interrupted') throw new Problem(409, 'После прерывания или публикации нужна ручная сверка; сообщение не отправлено.');
    const id = randomUUID();
    const run = this.store.runs().filter(r => r.task_id === taskId).at(-1);
    this.store.db.prepare(`INSERT INTO chat_messages (id, task_id, revision, run_id, kind, text, status) VALUES (?, ?, ?, ?, ?, ?, 'queued')`)
      .run(id, taskId, task.revision, run && ['queued', 'running'].includes(run.status) ? run.id : null, kind, text.trim());
    this.store.event('chat.queued', taskId, { message_id: id });
    if (kind === 'requirements' && !['queued', 'running'].includes(task.run_state)) this.store.applyRequirements(taskId);
    return { id };
  }
  control(run: AgentRun, steer: Steer | null) {
    if (this.store.blocked(run.task_id) || !this.store.hasRun(run)) return;
    if (steer) { this.controls.set(run.task_id, { run, steer }); this.flush(run.task_id); }
    else if (this.controls.get(run.task_id)?.run.id === run.id) this.controls.delete(run.task_id);
  }
  flush(taskId: string) {
    if (this.store.blocked(taskId)) return;
    const active = this.controls.get(taskId);
    if (!active) return;
    for (const message of this.messages(taskId).filter(m => m.status === 'queued' && m.kind === 'guidance' && m.revision === active.run.description_revision)) {
      this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE chat_messages SET status = 'sending', run_id = ?, session_id = ? WHERE id = ?").run(active.run.id, active.run.diagnostic?.session_id ?? null, message.id);
        this.store.event('chat.sending', taskId, { message_id: message.id });
      })();
      this.publish();
      this.deliveries.set(taskId, (this.deliveries.get(taskId) ?? 0) + 1);
      void active.steer(message.id, `User guidance for this task revision (does not replace the Spec, required questions, role boundaries or publication approval):\n${message.text}`).then(
        () => this.finish(message, 'delivered', null),
        error => this.finish(message, error instanceof DeliveryError ? error.status : 'unknown', error instanceof DeliveryError ? error.message : 'Неизвестный результат доставки. Нужна ручная сверка.'),
      ).catch(() => { this.error = 'Не удалось сохранить подтверждение чата. Новые этапы остановлены; нужна ручная сверка доставки перед restart.'; this.publish(); })
        .finally(() => { const remaining = this.deliveries.get(taskId)! - 1; if (remaining) this.deliveries.set(taskId, remaining); else this.deliveries.delete(taskId); });
    }
  }
  private finish(message: ChatMessage, status: ChatMessage['status'], error: string | null) {
    if (this.store.blocked(message.task_id)) return;
    if (!this.store.db.prepare('SELECT 1 FROM chat_messages WHERE id = ?').get(message.id)) return;
    this.store.db.transaction(() => {
      this.store.db.prepare("UPDATE chat_messages SET status = ?, error = ?, delivered_at = ? WHERE id = ? AND status = 'sending'")
        .run(status, error, status === 'delivered' ? new Date().toISOString() : null, message.id);
      this.store.event(`chat.${status}`, message.task_id, { message_id: message.id });
    })();
    this.publish();
  }
}
