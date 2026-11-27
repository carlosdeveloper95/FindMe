import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_PARTICIPANTS,
  MAX_POINTS_PER_PARTICIPANT,
  NAME_MAX_LENGTH,
  PARTICIPANT_COLORS,
  SESSION_TTL_MS,
  evaluatePoint,
  normalizeCode,
  normalizeName,
  type ApiErrorCode,
  type JoinResponse,
  type ParticipantInfo,
  type PointVerdict,
  type TrackPoint,
} from '@findme/shared';
import type { Db } from './db';

export class SessionError extends Error {
  constructor(public readonly code: ApiErrorCode) {
    super(code);
  }
}

export interface SessionRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
}

interface ParticipantRow {
  id: string;
  name: string;
  color: string;
  slot: number;
  token_hash: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest();

function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

const toInfo = (row: ParticipantRow): ParticipantInfo => ({
  id: row.id,
  name: row.name,
  color: row.color,
  slot: row.slot,
});

/** Toda a gestão de sessões, participantes e pontos sobre SQLite. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Cria uma sessão nova; quem cria ocupa o lugar 0 (azul). */
  createSession(rawName: unknown): JoinResponse {
    const name = normalizeName(rawName, NAME_MAX_LENGTH);
    if (!name) throw new SessionError('invalid_name');

    const createdAt = this.now();
    const expiresAt = createdAt + SESSION_TTL_MS;

    return this.db.transaction(() => {
      let code = generateCode();
      while (this.db.prepare('SELECT 1 FROM sessions WHERE code = ?').get(code)) {
        code = generateCode();
      }
      this.db
        .prepare('INSERT INTO sessions (code, created_at, expires_at) VALUES (?, ?, ?)')
        .run(code, createdAt, expiresAt);
      return this.addParticipant(code, 0, name, expiresAt);
    })();
  }

  /** Entra numa sessão existente pelo código. Falha se não existir, expirou ou está cheia. */
  joinSession(rawCode: unknown, rawName: unknown): JoinResponse {
    const code = typeof rawCode === 'string' ? normalizeCode(rawCode) : null;
    if (!code) throw new SessionError('invalid_code');
    const name = normalizeName(rawName, NAME_MAX_LENGTH);
    if (!name) throw new SessionError('invalid_name');

    return this.db.transaction(() => {
      const session = this.getSession(code);
      if (!session) throw new SessionError('not_found');
      const taken = this.db
        .prepare('SELECT slot FROM participants WHERE session_code = ?')
        .all(code) as { slot: number }[];
      if (taken.length >= MAX_PARTICIPANTS) throw new SessionError('full');
      const used = new Set(taken.map((t) => t.slot));
      let slot = 0;
      while (used.has(slot)) slot++;
      return this.addParticipant(code, slot, name, session.expiresAt);
    })();
  }

  private addParticipant(code: string, slot: number, name: string, expiresAt: number): JoinResponse {
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const color = PARTICIPANT_COLORS[slot % PARTICIPANT_COLORS.length]!;
    this.db
      .prepare(
        `INSERT INTO participants (id, session_code, slot, name, color, token_hash, joined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, code, slot, name, color, hashToken(token).toString('hex'), this.now());
    return { code, expiresAt, participant: { id, name, color, slot }, token };
  }

  /** Devolve a sessão se existir e ainda não tiver expirado. */
  getSession(code: string): SessionRecord | null {
    const row = this.db
      .prepare('SELECT code, created_at, expires_at FROM sessions WHERE code = ?')
      .get(code) as { code: string; created_at: number; expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now()) return null;
    return { code: row.code, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  /** Valida o par código + token. Só os dois participantes passam aqui. */
  authenticate(rawCode: unknown, token: unknown): ParticipantInfo | null {
    if (typeof rawCode !== 'string' || typeof token !== 'string' || token.length === 0) return null;
    const code = normalizeCode(rawCode);
    if (!code || !this.getSession(code)) return null;
    const given = hashToken(token);
    const rows = this.db
      .prepare('SELECT id, name, color, slot, token_hash FROM participants WHERE session_code = ?')
      .all(code) as ParticipantRow[];
    for (const row of rows) {
      if (timingSafeEqual(Buffer.from(row.token_hash, 'hex'), given)) return toInfo(row);
    }
    return null;
  }

  getParticipants(code: string): ParticipantInfo[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, color, slot, token_hash FROM participants WHERE session_code = ? ORDER BY slot',
      )
      .all(code) as ParticipantRow[];
    return rows.map(toInfo);
  }

  /** Trajeto completo de um participante, por ordem de registo. */
  getPoints(participantId: string): TrackPoint[] {
    return this.db
      .prepare('SELECT lat, lng, accuracy, ts FROM points WHERE participant_id = ? ORDER BY id')
      .all(participantId) as TrackPoint[];
  }

  getLastPoint(participantId: string): TrackPoint | null {
    const row = this.db
      .prepare(
        'SELECT lat, lng, accuracy, ts FROM points WHERE participant_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(participantId) as TrackPoint | undefined;
    return row ?? null;
  }

  /**
   * Aplica a filtragem (precisão e distância mínima) e guarda o ponto se for caso disso.
   * Devolve o veredicto para quem chama saber se o trajeto cresceu.
   */
  addPoint(participantId: string, point: TrackPoint): PointVerdict {
    const exists = this.db
      .prepare(
        `SELECT 1 FROM participants p JOIN sessions s ON s.code = p.session_code
         WHERE p.id = ? AND s.expires_at > ?`,
      )
      .get(participantId, this.now());
    if (!exists) return 'invalid';

    const verdict = evaluatePoint(this.getLastPoint(participantId), point);
    if (verdict !== 'store') return verdict;

    const { n } = this.db
      .prepare('SELECT COUNT(*) AS n FROM points WHERE participant_id = ?')
      .get(participantId) as { n: number };
    if (n >= MAX_POINTS_PER_PARTICIPANT) return 'too-close';

    this.db
      .prepare('INSERT INTO points (participant_id, lat, lng, accuracy, ts) VALUES (?, ?, ?, ?, ?)')
      .run(participantId, point.lat, point.lng, point.accuracy, Math.round(point.ts));
    return 'store';
  }

  /** Termina a sessão: apaga-a com todos os participantes e pontos. */
  endSession(code: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE code = ?').run(code).changes > 0;
  }

  /** Apaga as sessões expiradas (e os seus dados) e devolve os códigos removidos. */
  purgeExpired(): string[] {
    const rows = this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ? RETURNING code')
      .all(this.now()) as { code: string }[];
    return rows.map((r) => r.code);
  }
}
