import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeSpec } from '../src/server/codex.js';

// Real CLI/model call; keep its temporary artifacts for inspection.
const root = mkdtempSync(join(tmpdir(), 'swfactory-steer-smoke-'));
execFileSync('git', ['init', '-q', root]);
const directory = join(root, 'artifacts'); mkdirSync(directory);
let delivery: Promise<void> | undefined;
const result = await executeSpec({ cwd: root, directory, model: 'gpt-6.1-sol',
  prompt: 'Transport smoke test in an empty temporary repository. Do not edit files. First run the shell command sleep 3. Then return a valid READY Spec with title Smoke, one requirement and one acceptance criterion. Include any follow-up marker from the user in summary.',
  control: steer => {
    if (steer && !delivery) {
      delivery = steer('smoke-message', 'Use marker STEER_CONFIRMED_34 in your summary.');
      void delivery.catch(() => {});
    }
  },
});
assert.ok(delivery, 'CLI must expose an active turn');
await delivery;
assert.match(result.summary, /STEER_CONFIRMED_34/);
console.log(`PASS: active turn acknowledged and applied steering. Artifacts: ${directory}`);
