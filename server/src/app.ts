import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type Request, type Response } from 'express';
import { Server as IoServer } from 'socket.io';
import {
  isValidCoordinate,
  normalizeCode,
  type ApiErrorCode,
  type ClientToServerEvents,
  type ParticipantInfo,
  type ParticipantState,
  type ServerToClientEvents,
  type SessionState,
  type StatusEvent,
  type TrackPoint,
} from '@findme/shared';
import { SessionError, type SessionStore } from './sessions';

export interface AppOptions {
  store: SessionStore;
  /** Pasta com o build do cliente; se existir, é servida pelo mesmo servidor. */
  clientDir?: string;
  /** Número de proxies de confiança à frente do servidor (para obter o IP real). */
  trustProxy?: number;
  now?: () => number;
  /** Pedidos de criar/entrar permitidos por IP em cada minuto. */
  rateLimitPerMinute?: number;
}

export interface FindMeServer {
  app: Express;
  httpServer: HttpServer;
  io: IoServer<ClientToServerEvents, ServerToClientEvents>;
  /** Remove sessões expiradas e avisa quem ainda estiver ligado. */
  sweepExpired: () => void;
  close: () => Promise<void>;
}

interface SocketData {
  code: string;
  participant: ParticipantInfo;
}

interface Runtime {
  code: string;
  sockets: number;
  sharing: boolean;
  lastSeen: number | null;
  lastPosition: TrackPoint | null;
}

const ERROR_STATUS: Record<ApiErrorCode, number> = {
  invalid_name: 400,
  invalid_code: 400,
  not_found: 404,
  full: 409,
  rate_limited: 429,
};

/** Intervalo mínimo entre posições aceites da mesma ligação. */
const MIN_POSITION_INTERVAL_MS = 250;
/** Tolerância entre o relógio do dispositivo e o do servidor. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

const room = (code: string) => `session:${code}`;

export function createFindMeServer(options: AppOptions): FindMeServer {
  const { store } = options;
  const now = options.now ?? Date.now;
  const limit = options.rateLimitPerMinute ?? 30;

  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', options.trustProxy);
  app.use(express.json({ limit: '4kb' }));

  // --- Limite de tentativas por IP (protege contra adivinhar códigos) ---
  const hits = new Map<string, { count: number; resetAt: number }>();
  const rateLimited = (req: Request): boolean => {
    const key = req.ip ?? 'unknown';
    const t = now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      hits.set(key, { count: 1, resetAt: t + 60_000 });
      return false;
    }
    entry.count++;
    return entry.count > limit;
  };

  const sendError = (res: Response, err: unknown) => {
    if (err instanceof SessionError) {
      res.status(ERROR_STATUS[err.code]).json({ error: err.code });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal' });
  };

  // --- REST: criar sessão e entrar numa sessão ---
  app.post('/api/sessions', (req, res) => {
    if (rateLimited(req)) return void res.status(429).json({ error: 'rate_limited' });
    try {
      res.status(201).json(store.createSession(req.body?.name));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post('/api/sessions/:code/join', (req, res) => {
    if (rateLimited(req)) return void res.status(429).json({ error: 'rate_limited' });
    try {
      res.status(201).json(store.joinSession(req.params.code, req.body?.name));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get('/api/health', (_req, res) => void res.json({ ok: true }));
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'not_found' }));

  // --- Cliente (build de produção) ---
  const clientDir = options.clientDir;
  if (clientDir && existsSync(join(clientDir, 'index.html'))) {
    const noCache = (res: Response) => res.setHeader('Cache-Control', 'no-cache');
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders: (res, path) => {
          if (path.endsWith('sw.js') || path.endsWith('.webmanifest')) noCache(res);
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      noCache(res);
      res.sendFile(join(clientDir, 'index.html'));
    });
  }

  // --- Tempo real ---
  const httpServer = createServer(app);
  const io = new IoServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
    httpServer,
    { maxHttpBufferSize: 16 * 1024 },
  );

  /** Estado volátil por participante (ligações abertas, a partilhar, última posição). */
  const runtime = new Map<string, Runtime>();
  const getRuntime = (participantId: string, code: string): Runtime => {
    let rt = runtime.get(participantId);
    if (!rt) {
      rt = { code, sockets: 0, sharing: false, lastSeen: null, lastPosition: null };
      runtime.set(participantId, rt);
    }
    return rt;
  };

  const buildParticipant = (code: string, info: ParticipantInfo): ParticipantState => {
    const rt = getRuntime(info.id, code);
    const points = store.getPoints(info.id);
    const lastStored = points[points.length - 1] ?? null;
    return {
      ...info,
      online: rt.sockets > 0,
      sharing: rt.sharing,
      lastSeen: rt.lastSeen ?? lastStored?.ts ?? null,
      lastPosition: rt.lastPosition ?? lastStored,
      points,
    };
  };

  const statusOf = (participantId: string, rt: Runtime): StatusEvent => {
    return { participantId, online: rt.sockets > 0, sharing: rt.sharing, lastSeen: rt.lastSeen };
  };

  const forgetSession = (code: string) => {
    for (const [id, rt] of runtime) if (rt.code === code) runtime.delete(id);
  };

  // Só entra quem apresentar o código e o token de um dos dois participantes.
  io.use((socket, next) => {
    const auth = socket.handshake.auth as { code?: unknown; token?: unknown };
    const code = typeof auth.code === 'string' ? normalizeCode(auth.code) : null;
    const participant = code ? store.authenticate(code, auth.token) : null;
    if (!code || !participant) return next(new Error('unauthorized'));
    socket.data = { code, participant };
    next();
  });

  io.on('connection', (socket) => {
    const { code, participant } = socket.data;
    const me = participant.id;
    const rt = getRuntime(me, code);
    rt.sockets++;
    socket.join(room(code));

    const session = store.getSession(code);
    if (!session) {
      socket.emit('ended', { reason: 'expired' });
      socket.disconnect(true);
      return;
    }

    // Quem entra a meio ou recarrega recebe os trajetos completos.
    const state: SessionState = {
      code,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      serverNow: now(),
      me,
      participants: store.getParticipants(code).map((p) => buildParticipant(code, p)),
    };
    socket.emit('state', state);
    socket.to(room(code)).emit('participant', buildParticipant(code, participant));

    let lastPositionAt = 0;

    socket.on('position', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      if (!isValidCoordinate(raw.lat, raw.lng) || typeof raw.accuracy !== 'number') return;
      const t = now();
      if (t - lastPositionAt < MIN_POSITION_INTERVAL_MS) return;
      lastPositionAt = t;

      const ts =
        typeof raw.ts === 'number' && Math.abs(raw.ts - t) <= MAX_CLOCK_SKEW_MS ? Math.round(raw.ts) : t;
      const point: TrackPoint = { lat: raw.lat, lng: raw.lng, accuracy: raw.accuracy, ts };

      const verdict = store.addPoint(me, point);
      if (verdict === 'invalid' || verdict === 'inaccurate') return;

      rt.sharing = true;
      rt.lastSeen = t;
      rt.lastPosition = point;
      io.to(room(code)).emit('position', { participantId: me, point, stored: verdict === 'store' });
    });

    socket.on('sharing', (active) => {
      rt.sharing = active === true;
      rt.lastSeen = now();
      io.to(room(code)).emit('status', statusOf(me, rt));
    });

    socket.on('heartbeat', () => {
      rt.lastSeen = now();
      io.to(room(code)).emit('status', statusOf(me, rt));
    });

    socket.on('end', (ack) => {
      if (store.endSession(code)) {
        io.to(room(code)).emit('ended', { reason: 'ended', by: me });
      }
      forgetSession(code);
      if (typeof ack === 'function') ack();
      io.in(room(code)).disconnectSockets(true);
    });

    socket.on('disconnect', () => {
      const current = runtime.get(me);
      if (!current) return; // sessão já terminada
      current.sockets = Math.max(0, current.sockets - 1);
      if (current.sockets === 0) current.sharing = false;
      io.to(room(code)).emit('status', statusOf(me, current));
    });
  });

  const sweepExpired = () => {
    for (const [key, entry] of hits) if (entry.resetAt <= now()) hits.delete(key);
    for (const code of store.purgeExpired()) {
      io.to(room(code)).emit('ended', { reason: 'expired' });
      io.in(room(code)).disconnectSockets(true);
      forgetSession(code);
    }
  };

  const close = () =>
    new Promise<void>((resolve) => {
      io.close(() => resolve());
    });

  return { app, httpServer, io, sweepExpired, close };
}
