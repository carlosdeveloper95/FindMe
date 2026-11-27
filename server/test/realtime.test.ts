import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  JoinResponse,
  ServerToClientEvents,
  SessionState,
} from '@findme/shared';
import { SESSION_TTL_MS } from '@findme/shared';
import { createFindMeServer, type FindMeServer } from '../src/app';
import { openDb, type Db } from '../src/db';
import { SessionStore } from '../src/sessions';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const lisboa = { lat: 38.7223, lng: -9.1393 };
const north = (meters: number) => ({ lat: lisboa.lat + meters / 111_195, lng: lisboa.lng });

let db: Db;
let server: FindMeServer;
let base: string;
let clock: number;
let clients: Client[];

beforeEach(async () => {
  clock = Date.now();
  db = openDb(':memory:');
  server = createFindMeServer({ store: new SessionStore(db, () => clock), now: () => clock });
  await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  clients = [];
});

afterEach(async () => {
  for (const c of clients) c.disconnect();
  await server.close();
  db.close();
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as JoinResponse & { error?: string } };
};

const once = <E extends keyof ServerToClientEvents>(socket: Client, event: E) =>
  new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve) => {
    socket.once(event, ((payload: never) => resolve(payload)) as never);
  });

/** Liga um participante e espera pelo estado inicial. */
const join = async (creds: { code: string; token: string }) => {
  const socket: Client = connect(base, { auth: creds, transports: ['websocket'], forceNew: true });
  clients.push(socket);
  const state = await once(socket, 'state');
  return { socket, state: state as SessionState };
};

/** Avança o relógio para o servidor não descartar posições seguidas. */
const send = (socket: Client, pos: { lat: number; lng: number }, accuracy = 10) => {
  clock += 1000;
  socket.emit('position', { ...pos, accuracy, ts: clock });
};

/** Envia uma posição e espera que o servidor a devolva à sala. */
const sendAndWait = async (socket: Client, pos: { lat: number; lng: number }) => {
  const echoed = once(socket, 'position');
  send(socket, pos);
  return echoed;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('REST', () => {
  it('cria, deixa entrar o segundo e recusa o terceiro', async () => {
    const a = await post('/api/sessions', { name: 'Ana' });
    expect(a.status).toBe(201);
    const b = await post(`/api/sessions/${a.body.code}/join`, { name: 'Bruno' });
    expect(b.status).toBe(201);
    const c = await post(`/api/sessions/${a.body.code}/join`, { name: 'Carla' });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('full');
  });

  it('responde 404 a códigos desconhecidos e 400 a nomes vazios', async () => {
    expect((await post('/api/sessions/ABCDEFGHJK/join', { name: 'Bruno' })).status).toBe(404);
    expect((await post('/api/sessions', { name: '' })).status).toBe(400);
  });

  it('limita o número de tentativas por IP', async () => {
    await server.close();
    server = createFindMeServer({ store: new SessionStore(db), rateLimitPerMinute: 3 });
    await new Promise<void>((r) => server.httpServer.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await post('/api/sessions/ABCDEFGHJK/join', { name: 'x' })).status);
    }
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
  });
});

describe('tempo real', () => {
  it('recusa ligações sem credenciais válidas', async () => {
    const a = (await post('/api/sessions', { name: 'Ana' })).body;
    const socket: Client = connect(base, {
      auth: { code: a.code, token: 'errado' },
      transports: ['websocket'],
      forceNew: true,
    });
    clients.push(socket);
    const err = await new Promise<Error>((r) => socket.once('connect_error', r));
    expect(err.message).toBe('unauthorized');
  });

  it('cada posição chega ao outro participante', async () => {
    const a = (await post('/api/sessions', { name: 'Ana' })).body;
    const b = (await post(`/api/sessions/${a.code}/join`, { name: 'Bruno' })).body;
    const ana = await join(a);
    const announced = once(ana.socket, 'participant');
    const bruno = await join(b);

    expect(ana.state.me).toBe(a.participant.id);
    expect(bruno.state.participants.map((p) => p.name)).toEqual(['Ana', 'Bruno']);
    expect((await announced).name).toBe('Bruno');

    const received = once(bruno.socket, 'position');
    send(ana.socket, lisboa);
    const event = await received;
    expect(event).toMatchObject({ participantId: a.participant.id, stored: true });
    expect(event.point).toMatchObject({ ...lisboa, accuracy: 10 });
  });

  it('posições paradas atualizam o marcador mas não o trajeto; as imprecisas são ignoradas', async () => {
    const a = (await post('/api/sessions', { name: 'Ana' })).body;
    const ana = await join(a);
    const events: boolean[] = [];
    ana.socket.on('position', (e) => events.push(e.stored));

    await sendAndWait(ana.socket, lisboa);
    await sendAndWait(ana.socket, north(2)); // parado: não entra no trajeto
    send(ana.socket, north(200), 90); // impreciso: ignorado por completo
    await sleep(100);
    await sendAndWait(ana.socket, north(15));

    expect(events).toEqual([true, false, true]);
    const reloaded = await join(a);
    expect(reloaded.state.participants[0]!.points).toHaveLength(2);
  });

  it('quem entra a meio ou recarrega recebe os trajetos completos', async () => {
    const a = (await post('/api/sessions', { name: 'Ana' })).body;
    const ana = await join(a);
    for (const m of [0, 20, 40, 60]) await sendAndWait(ana.socket, north(m));

    const b = (await post(`/api/sessions/${a.code}/join`, { name: 'Bruno' })).body;
    const bruno = await join(b);
    const anaSeenByBruno = bruno.state.participants.find((p) => p.id === a.participant.id)!;
    expect(anaSeenByBruno.points).toHaveLength(4);
    expect(anaSeenByBruno.sharing).toBe(true);
    expect(anaSeenByBruno.lastPosition).toMatchObject(north(60));

    ana.socket.disconnect();
    const again = await join(a);
    expect(again.state.participants[0]!.points).toHaveLength(4);
  });

  it('pausar e desligar são comunicados ao outro', async () => {
    const a = (await post('/api/sessions', { name: 'Ana' })).body;
    const b = (await post(`/api/sessions/${a.code}/join`, { name: 'Bruno' })).body;
    const ana = await join(a);
    const bruno = await join(b);

    let status = once(bruno.socket, 'status');
    ana.socket.emit('sharing', true);
    expect(await status).toMatchObject({ participantId: a.participant.id, sharing: true, online: true });

    status = once(bruno.socket, 'status');
    ana.socket.emit('sharing', false);
    expect(await status).toMatchObject({ sharing: false, online: true });

    status = once(bruno.socket, 'status');
    ana.socket.disconnect();
    expect(await status).toMatchObject({ sharing: false, online: false });
  });

  it('terminar a sessão avisa os dois e apaga tudo do servidor', async () => {
    const a = (await post('/api/sessions', { name: 'Ana' })).body;
    const b = (await post(`/api/sessions/${a.code}/join`, { name: 'Bruno' })).body;
    const ana = await join(a);
    const bruno = await join(b);
    const got = once(bruno.socket, 'position');
    send(ana.socket, lisboa);
    await got;

    const endedForBruno = once(bruno.socket, 'ended');
    const endedForAna = once(ana.socket, 'ended');
    bruno.socket.emit('end');
    expect(await endedForBruno).toEqual({ reason: 'ended', by: b.participant.id });
    expect(await endedForAna).toEqual({ reason: 'ended', by: b.participant.id });

    for (const table of ['sessions', 'participants', 'points']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    expect((await post(`/api/sessions/${a.code}/join`, { name: 'Carla' })).status).toBe(404);
  });

  it('as sessões expiradas são apagadas e os ligados avisados', async () => {
    const a = (await post('/api/sessions', { name: 'Ana' })).body;
    const ana = await join(a);
    const ended = once(ana.socket, 'ended');
    clock += SESSION_TTL_MS + 1;
    server.sweepExpired();
    expect(await ended).toEqual({ reason: 'expired' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n).toBe(0);
  });
});
