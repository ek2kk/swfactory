import { discoverModels, supportsFast } from './models.js';
import { CodexFailure } from './diagnostics.js';
import type { CodexInput } from './codex.js';

export class FastModeFailure extends CodexFailure {
  constructor(message: string) { super('protocol_error'); this.message = message; this.finished = true; }
}

export async function prepareFast(input: CodexInput, version: string | undefined, executable: string): Promise<string[]> {
  if (input.fast === undefined) return [];
  if (!supportsFast(version)) throw new FastModeFailure('Режим Fast/обычный не подтверждён этой версией Codex. Требуется CLI 0.162.1 или новее; fallback запрещён.');
  if (input.fast) {
    let models;
    try { models = await discoverModels(input.cwd, executable); }
    catch { throw new FastModeFailure('Fast не применён: Codex не подтвердил каталог моделей и авторизацию.'); }
    const fast = models.find(model => model.id === input.model)?.fast;
    if (!fast?.supported) throw new FastModeFailure(`Fast не применён: ${fast?.reason ?? 'модель отсутствует в актуальном каталоге Codex или не содержит подтверждения Fast.'}`);
  }
  // Explicit default overrides service_tier inherited from user/project CLI config.
  return ['-c', `service_tier="${input.fast ? 'fast' : 'default'}"`, '-c', 'features.fast_mode=true'];
}
