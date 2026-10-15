import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

process.umask(0o077);
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT должен быть целым числом от 1024 до 65535.');
if (process.versions.node.split('.')[0] !== '24') throw new Error('Используйте Node.js 24 LTS (см. .nvmrc).');
const origin = `http://127.0.0.1:${port}`;
const { app, token } = await createApp({
  directory: process.env.SWFACTORY_DATA_DIR ?? join(homedir(), 'Library/Application Support/AgentKanban'),
  origin, staticRoot: fileURLToPath(new URL('../client/', import.meta.url)),
});
try {
  await app.listen({ host: '127.0.0.1', port });
  console.error(`SW Factory: ${origin}/#token=${token}`);
} catch {
  app.log.error({ event: 'backend.start-failed', error_kind: 'listen_failed' });
  await app.close(); process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  app.close().catch(() => { app.log.error({ event: 'backend.shutdown-failed', error_kind: 'shutdown_failed' }); process.exitCode = 1; });
});
