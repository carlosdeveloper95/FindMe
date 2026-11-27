import { beforeEach, describe, expect, it } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  PARTICIPANT_COLORS,
  SESSION_TTL_MS,
  formatCode,
} from '@findme/shared';
import { openDb, type Db } from '../src/db';
import { SessionError, SessionStore } from '../src/sessions';

const lisboa = { lat: 38.7223, lng: -9.1393 };
const north = (meters: number) => ({ lat: lisboa.lat + meters / 111_195, lng: lisboa.lng });

let db: Db;
let clock: number;
let store: SessionStore;

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

const errorCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof SessionError) return err.code;
    throw err;
  }
  return null;
};

beforeEach(() => {
  db = openDb(':memory:');
  clock = 1_800_000_000_000;
  store = new SessionStore(db, () => clock);
});

describe('criar sessão', () => {
  it('gera um código válido e atribui a cor azul a quem cria', () => {
    const res = store.createSession('Ana');
    expect(res.code).toHaveLength(CODE_LENGTH);
    expect([...res.code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    expect(res.participant).toMatchObject({ name: 'Ana', slot: 0, color: PARTICIPANT_COLORS[0] });
    expect(res.expiresAt).toBe(clock + SESSION_TTL_MS);
    expect(res.token.length).toBeGreaterThanOrEqual(40);
  });

  it('gera códigos e tokens diferentes de cada vez', () => {
    const codes = new Set(Array.from({ length: 200 }, () => store.createSession('Ana').code));
    expect(codes.size).toBe(200);
  });

  it('não guarda o token em claro', () => {
    const res = store.createSession('Ana');
    const row = db.prepare('SELECT token_hash FROM participants').get() as { token_hash: string };
    expect(row.token_hash).not.toContain(res.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejeita nomes inválidos', () => {
    expect(errorCode(() => store.createSession('   '))).toBe('invalid_name');
    expect(errorCode(() => store.createSession('x'.repeat(25)))).toBe('invalid_name');
    expect(errorCode(() => store.createSession(undefined))).toBe('invalid_name');
    expect(count('sessions')).toBe(0);
  });
});

describe('entrar na sessão', () => {
  it('o segundo participante fica laranja', () => {
    const a = store.createSession('Ana');
    const b = store.joinSession(a.code, 'Bruno');
    expect(b.code).toBe(a.code);
    expect(b.participant).toMatchObject({ name: 'Bruno', slot: 1, color: PARTICIPANT_COLORS[1] });
    expect(b.participant.id).not.toBe(a.participant.id);
    expect(store.getParticipants(a.code).map((p) => p.name)).toEqual(['Ana', 'Bruno']);
  });

  it('aceita o código com hífen e em minúsculas', () => {
    const a = store.createSession('Ana');
    const b = store.joinSession(formatCode(a.code).toLowerCase(), 'Bruno');
    expect(b.code).toBe(a.code);
  });

  it('recusa um terceiro participante', () => {
    const a = store.createSession('Ana');
    store.joinSession(a.code, 'Bruno');
    expect(errorCode(() => store.joinSession(a.code, 'Carla'))).toBe('full');
    expect(count('participants')).toBe(2);
  });

  it('recusa códigos inexistentes ou mal formados', () => {
    expect(errorCode(() => store.joinSession('ABCDEFGHJK', 'Bruno'))).toBe('not_found');
    expect(errorCode(() => store.joinSession('abc', 'Bruno'))).toBe('invalid_code');
    expect(errorCode(() => store.joinSession(null, 'Bruno'))).toBe('invalid_code');
  });

  it('recusa entrar numa sessão expirada', () => {
    const a = store.createSession('Ana');
    clock += SESSION_TTL_MS;
    expect(errorCode(() => store.joinSession(a.code, 'Bruno'))).toBe('not_found');
  });
});

describe('autenticação', () => {
  it('só aceita o token certo para a sessão certa', () => {
    const a = store.createSession('Ana');
    const b = store.joinSession(a.code, 'Bruno');
    const other = store.createSession('Outra');

    expect(store.authenticate(a.code, a.token)?.id).toBe(a.participant.id);
    expect(store.authenticate(a.code, b.token)?.id).toBe(b.participant.id);
    expect(store.authenticate(a.code, 'token-errado')).toBeNull();
    expect(store.authenticate(a.code, other.token)).toBeNull();
    expect(store.authenticate(other.code, a.token)).toBeNull();
    expect(store.authenticate(a.code, '')).toBeNull();
    expect(store.authenticate(a.code, undefined)).toBeNull();
  });

  it('deixa de aceitar depois de a sessão expirar', () => {
    const a = store.createSession('Ana');
    clock += SESSION_TTL_MS + 1;
    expect(store.authenticate(a.code, a.token)).toBeNull();
  });
});

describe('pontos do trajeto', () => {
  const point = (pos: { lat: number; lng: number }, accuracy = 10) => ({
    ...pos,
    accuracy,
    ts: clock,
  });

  it('guarda latitude, longitude, precisão e timestamp', () => {
    const a = store.createSession('Ana');
    expect(store.addPoint(a.participant.id, point(lisboa, 12.5))).toBe('store');
    expect(store.getPoints(a.participant.id)).toEqual([{ ...lisboa, accuracy: 12.5, ts: clock }]);
  });

  it('ignora pontos imprecisos e movimentos pequenos', () => {
    const a = store.createSession('Ana');
    const id = a.participant.id;
    expect(store.addPoint(id, point(lisboa))).toBe('store');
    expect(store.addPoint(id, point(north(100), 80))).toBe('inaccurate');
    expect(store.addPoint(id, point(north(3)))).toBe('too-close');
    expect(store.addPoint(id, point(north(20)))).toBe('store');
    // A distância mede-se ao último ponto GUARDADO, não ao último recebido.
    expect(store.addPoint(id, point(north(25)))).toBe('too-close');
    expect(store.addPoint(id, point(north(30)))).toBe('store');
    expect(store.getPoints(id)).toHaveLength(3);
  });

  it('mantém os trajetos de cada pessoa separados', () => {
    const a = store.createSession('Ana');
    const b = store.joinSession(a.code, 'Bruno');
    store.addPoint(a.participant.id, point(lisboa));
    store.addPoint(b.participant.id, point(north(1)));
    expect(store.getPoints(a.participant.id)).toHaveLength(1);
    expect(store.getPoints(b.participant.id)).toHaveLength(1);
  });

  it('recusa pontos de participantes desconhecidos ou de sessões expiradas', () => {
    expect(store.addPoint('nao-existe', point(lisboa))).toBe('invalid');
    const a = store.createSession('Ana');
    clock += SESSION_TTL_MS;
    expect(store.addPoint(a.participant.id, point(lisboa))).toBe('invalid');
  });
});

describe('terminar e expirar', () => {
  it('terminar apaga a sessão, os participantes e os pontos', () => {
    const a = store.createSession('Ana');
    const b = store.joinSession(a.code, 'Bruno');
    const keep = store.createSession('Outra');
    store.addPoint(a.participant.id, { ...lisboa, accuracy: 5, ts: clock });
    store.addPoint(b.participant.id, { ...north(50), accuracy: 5, ts: clock });
    store.addPoint(keep.participant.id, { ...lisboa, accuracy: 5, ts: clock });

    expect(store.endSession(a.code)).toBe(true);

    expect(store.getSession(a.code)).toBeNull();
    expect(store.authenticate(a.code, a.token)).toBeNull();
    expect(count('sessions')).toBe(1);
    expect(count('participants')).toBe(1);
    expect(count('points')).toBe(1);
    expect(store.endSession(a.code)).toBe(false);
  });

  it('a limpeza remove apenas as sessões com mais de 24 h', () => {
    const old = store.createSession('Ana');
    store.addPoint(old.participant.id, { ...lisboa, accuracy: 5, ts: clock });
    clock += SESSION_TTL_MS - 1000;
    const recent = store.createSession('Bruno');

    expect(store.purgeExpired()).toEqual([]);
    clock += 1000;
    expect(store.purgeExpired()).toEqual([old.code]);
    expect(count('points')).toBe(0);
    expect(store.getSession(recent.code)).not.toBeNull();
  });
});
