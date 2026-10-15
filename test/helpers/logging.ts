import Fastify, { LogController } from 'fastify';
import { Writable } from 'node:stream';
import { loggerOptions } from '../../src/server/logging.js';

export function captureLogs(secrets: string[] = []) {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({ write(chunk, _encoding, done) {
    for (const line of String(chunk).trim().split('\n')) lines.push(JSON.parse(line));
    done();
  } });
  const app = Fastify({ logger: loggerOptions(secrets, stream), logController: new LogController({ disableRequestLogging: true }) });
  return { app, log: app.log, stream, lines };
}
