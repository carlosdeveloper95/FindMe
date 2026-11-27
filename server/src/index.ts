import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFindMeServer } from './app';
import { openDb } from './db';
import { SessionStore } from './sessions';

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '0.0.0.0';
const dbPath = resolve(process.env.DB_PATH ?? resolve(here, '../data/findme.db'));
const clientDir = resolve(process.env.CLIENT_DIR ?? resolve(here, '../../client/dist'));
const trustProxy = Number(process.env.TRUST_PROXY ?? 0);

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const store = new SessionStore(db);
const server = createFindMeServer({ store, clientDir, trustProxy });

// Sessões expiradas (24 h) são apagadas ao arrancar e depois a cada 5 minutos.
server.sweepExpired();
const sweep = setInterval(server.sweepExpired, 5 * 60_000);

server.httpServer.listen(port, host, () => {
  console.log(`FindMe a ouvir em http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});

const shutdown = () => {
  clearInterval(sweep);
  void server.close().then(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
