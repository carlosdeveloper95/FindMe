import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HEARTBEAT_MS,
  OFFLINE_AFTER_MS,
  distanceMeters,
  evaluatePoint,
  formatCode,
  trackLengthMeters,
  type ParticipantState,
  type TrackPoint,
} from '@findme/shared';
import { formatAgo, formatDistance, formatTime } from '../format';
import { loadSharing, saveSharing, type StoredSession } from '../storage';
import { useGeolocation, type GeoError } from '../useGeolocation';
import { useSession, type GoneReason } from '../useSession';
import { MapView, type MapHandle, type MapPerson } from './MapView';

type Presence = 'sharing' | 'paused' | 'offline';

/** Intervalo mínimo entre posições enviadas ao servidor. */
const SEND_INTERVAL_MS = 1000;

const GEO_MESSAGES: Record<GeoError, string> = {
  denied:
    'O acesso à localização foi recusado. Autoriza a localização para este site nas definições do browser e tenta outra vez.',
  unavailable: 'Não foi possível obter a tua localização. Confirma que o GPS está ligado.',
  timeout: 'O GPS está a demorar a responder. Tenta ir para um sítio com céu aberto.',
  unsupported: 'Este browser não suporta geolocalização.',
};

function presenceOf(p: ParticipantState, now: number): Presence {
  if (!p.online) return 'offline';
  if (!p.sharing) return 'paused';
  // A pessoa diz que partilha mas deixou de dar sinais de vida (ex.: app em segundo plano).
  if (p.lastSeen !== null && now - p.lastSeen > OFFLINE_AFTER_MS) return 'offline';
  return 'sharing';
}

const PRESENCE_LABEL: Record<Presence, string> = {
  sharing: 'A partilhar',
  paused: 'Em pausa',
  offline: 'Offline',
};

/** Relógio que obriga a redesenhar para atualizar "há X s" e o estado offline. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function PersonRow({
  person,
  isMe,
  presence,
  now,
}: {
  person: ParticipantState;
  isMe: boolean;
  presence: Presence;
  now: number;
}) {
  const travelled = useMemo(() => trackLengthMeters(person.points), [person.points]);
  const updatedAt = person.lastPosition ? person.lastSeen ?? person.lastPosition.ts : null;
  return (
    <li className="person" data-testid={isMe ? 'row-me' : 'row-friend'}>
      <span className="person__dot" style={{ background: person.color }} aria-hidden />
      <div className="person__main">
        <div className="person__name">
          {person.name}
          {isMe && <span className="person__you"> (tu)</span>}
        </div>
        <div className="person__meta">
          <span data-testid="travelled">{formatDistance(travelled)} percorridos</span>
          {updatedAt !== null && (
            <>
              {' · '}
              <span title={formatAgo(now - updatedAt)}>atualizado às {formatTime(updatedAt)}</span>
            </>
          )}
        </div>
      </div>
      <span className={`badge badge--${presence}`} data-testid="presence">
        {PRESENCE_LABEL[presence]}
      </span>
    </li>
  );
}

function InviteCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/s/${code}`;

  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'FindMe',
          text: 'Junta-te a mim no FindMe para partilharmos a localização.',
          url: link,
        });
        return;
      }
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* partilha cancelada ou área de transferência indisponível */
    }
  };

  return (
    <div className="invite" data-testid="invite">
      <div className="invite__text">
        <strong>À espera do teu amigo</strong>
        <span>Envia-lhe o link ou dita-lhe o código:</span>
      </div>
      <div className="invite__code" data-testid="invite-code">
        {formatCode(code)}
      </div>
      <input className="invite__link" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Link de convite" />
      <button type="button" className="btn btn--secondary" onClick={share}>
        {copied ? 'Link copiado ✓' : 'Partilhar link de convite'}
      </button>
    </div>
  );
}

export function SessionView({
  creds,
  onGone,
}: {
  creds: StoredSession;
  onGone: (reason: GoneReason) => void;
}) {
  const { session, connected, sendPosition, sendSharing, sendHeartbeat, endSession } = useSession(
    creds,
    onGone,
  );
  const [sharing, setSharingState] = useState(() => loadSharing(creds.code));
  const sharingRef = useRef(sharing);
  const [weakAccuracy, setWeakAccuracy] = useState<number | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const lastSentAt = useRef(0);
  /** Posição mais recente à espera de vez para ser enviada. */
  const pending = useRef<{ fix: TrackPoint; timer: ReturnType<typeof setTimeout> } | null>(null);
  const mapRef = useRef<MapHandle>(null);
  const now = useNow(2000);

  const dropPending = () => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
  };
  useEffect(() => dropPending, []);

  const setSharing = useCallback(
    (active: boolean) => {
      // A referência muda já, para nenhuma posição ser enviada depois de pausar.
      sharingRef.current = active;
      setSharingState(active);
      saveSharing(creds.code, active);
      if (!active) {
        setWeakAccuracy(null);
        dropPending();
      }
    },
    [creds.code],
  );

  const onFix = useCallback(
    (fix: TrackPoint) => {
      if (!sharingRef.current) return;
      const verdict = evaluatePoint(null, fix);
      if (verdict === 'invalid') return;
      if (verdict === 'inaccurate') {
        setWeakAccuracy(fix.accuracy);
        return;
      }
      setWeakAccuracy(null);

      // No máximo um envio por segundo, mas a posição mais recente nunca se perde:
      // se chegar cedo demais, fica à espera e segue quando o intervalo terminar.
      const wait = lastSentAt.current + SEND_INTERVAL_MS - Date.now();
      if (wait <= 0) {
        dropPending();
        lastSentAt.current = Date.now();
        sendPosition(fix);
        return;
      }
      if (pending.current) {
        pending.current.fix = fix;
        return;
      }
      const timer = setTimeout(() => {
        const latest = pending.current?.fix;
        pending.current = null;
        if (!latest || !sharingRef.current) return;
        lastSentAt.current = Date.now();
        sendPosition(latest);
      }, wait);
      pending.current = { fix, timer };
    },
    [sendPosition],
  );

  const geo = useGeolocation(sharing, onFix);

  // Sem permissão não há partilha: o botão volta ao estado inicial.
  useEffect(() => {
    if (geo.error === 'denied' || geo.error === 'unsupported') setSharing(false);
  }, [geo.error, setSharing]);

  // Anuncia o estado da partilha (também ao reconectar) e mantém o sinal de vida.
  useEffect(() => {
    if (!connected) return;
    sendSharing(sharing);
    if (!sharing) return;
    const id = setInterval(sendHeartbeat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [connected, sharing, sendSharing, sendHeartbeat]);

  useEffect(() => {
    if (!hint) return;
    const id = setTimeout(() => setHint(null), 3000);
    return () => clearTimeout(id);
  }, [hint]);

  const me = session?.participants.find((p) => p.id === session.me) ?? null;
  const friend = session?.participants.find((p) => p.id !== session.me) ?? null;

  const myPresence: Presence = !connected ? 'offline' : sharing ? 'sharing' : 'paused';
  const friendPresence = friend ? presenceOf(friend, now) : null;

  const people = useMemo<MapPerson[]>(
    () =>
      (session?.participants ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        points: p.points,
        lastPosition: p.lastPosition,
        stale: p.id === session?.me ? !sharing : presenceOf(p, now) !== 'sharing',
      })),
    [session, sharing, now],
  );

  const between =
    me?.lastPosition && friend?.lastPosition
      ? distanceMeters(me.lastPosition, friend.lastPosition)
      : null;

  const centerOn = (id: string | undefined, missing: string) => {
    if (!id || !mapRef.current?.centerOn(id)) setHint(missing);
  };

  return (
    <div className="session">
      <header className="topbar">
        <span className="topbar__brand">FindMe</span>
        <span
          className={`indicator ${sharing ? 'indicator--on' : 'indicator--off'}`}
          role="status"
          data-testid="sharing-indicator"
        >
          <span className="indicator__dot" aria-hidden />
          {sharing ? 'A partilhar a tua localização' : 'Localização não partilhada'}
        </span>
      </header>

      {!connected && session && (
        <div className="banner banner--warn" role="status">
          Sem ligação ao servidor. A tentar reconectar…
        </div>
      )}

      <div className="map-area">
        <MapView ref={mapRef} people={people} />
        <div className="map-controls">
          <button
            type="button"
            className="chip"
            onClick={() => centerOn(me?.id, 'Ainda não temos a tua posição.')}
          >
            <span className="chip__dot" style={{ background: me?.color ?? '#94a3b8' }} aria-hidden />
            Eu
          </button>
          <button
            type="button"
            className="chip"
            disabled={!friend}
            onClick={() => centerOn(friend?.id, `Ainda não temos a posição de ${friend?.name ?? 'o teu amigo'}.`)}
          >
            <span className="chip__dot" style={{ background: friend?.color ?? '#94a3b8' }} aria-hidden />
            {friend?.name ?? 'Amigo'}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => {
              if (!mapRef.current?.fitAll()) setHint('Ainda não há posições para mostrar.');
            }}
          >
            Ver os dois
          </button>
        </div>
        {hint && (
          <div className="toast" role="status">
            {hint}
          </div>
        )}
      </div>

      <section className="panel" aria-label="Estado da sessão">
        {!session ? (
          <p className="panel__loading">A ligar à sessão…</p>
        ) : (
          <>
            {between !== null && (
              <p className="between" data-testid="between">
                Estão a <strong>{formatDistance(between)}</strong> um do outro
              </p>
            )}

            <ul className="people">
              {me && <PersonRow person={me} isMe presence={myPresence} now={now} />}
              {friend && friendPresence && (
                <PersonRow person={friend} isMe={false} presence={friendPresence} now={now} />
              )}
            </ul>

            {!friend && <InviteCard code={session.code} />}

            {geo.error && !(!sharing && geo.error === 'timeout') && (
              <p className="notice notice--error" role="alert">
                {GEO_MESSAGES[geo.error]}
              </p>
            )}
            {sharing && weakAccuracy !== null && (
              <p className="notice" role="status">
                Sinal de GPS fraco (±{Math.round(weakAccuracy)} m). As posições só contam com precisão
                melhor que 50 m.
              </p>
            )}

            <button
              type="button"
              className={`btn ${sharing ? 'btn--pause' : 'btn--primary'}`}
              data-testid="toggle-sharing"
              onClick={() => {
                geo.clearError();
                setSharing(!sharing);
              }}
            >
              {sharing
                ? 'Pausar a partilha'
                : me && me.points.length > 0
                  ? 'Retomar a partilha'
                  : 'Partilhar a minha localização'}
            </button>

            {confirmEnd ? (
              <div className="confirm" role="alertdialog" aria-label="Terminar sessão">
                <p>Terminar a sessão para os dois e apagar os trajetos do servidor?</p>
                <div className="confirm__actions">
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmEnd(false)}>
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger"
                    data-testid="confirm-end"
                    disabled={!connected}
                    onClick={() => {
                      setSharing(false);
                      endSession();
                    }}
                  >
                    Terminar e apagar
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--ghost btn--danger-text"
                data-testid="end-session"
                onClick={() => setConfirmEnd(true)}
              >
                Terminar sessão
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
