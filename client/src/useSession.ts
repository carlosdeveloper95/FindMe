import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ParticipantState,
  PositionEvent,
  ServerToClientEvents,
  SessionState,
  StatusEvent,
  TrackPoint,
} from '@findme/shared';
import type { StoredSession } from './storage';

/** Porque é que a sessão deixou de existir para este dispositivo. */
export type GoneReason = 'ended-by-me' | 'ended-by-friend' | 'expired' | 'unauthorized';

/**
 * Estado da sessão no cliente. Os `lastSeen` estão convertidos para o relógio
 * deste dispositivo (`clockOffset` = relógio local − relógio do servidor).
 */
export interface ClientSession {
  code: string;
  expiresAt: number;
  me: string;
  clockOffset: number;
  participants: ParticipantState[];
}

type Action =
  | { type: 'state'; state: SessionState }
  | { type: 'participant'; participant: ParticipantState }
  | { type: 'position'; event: PositionEvent }
  | { type: 'status'; event: StatusEvent };

const toLocal = (ts: number | null, offset: number) => (ts === null ? null : ts + offset);

const bySlot = (a: ParticipantState, b: ParticipantState) => a.slot - b.slot;

function reducer(session: ClientSession | null, action: Action): ClientSession | null {
  if (action.type === 'state') {
    const { state } = action;
    const clockOffset = Date.now() - state.serverNow;
    return {
      code: state.code,
      expiresAt: state.expiresAt,
      me: state.me,
      clockOffset,
      participants: state.participants
        .map((p) => ({ ...p, lastSeen: toLocal(p.lastSeen, clockOffset) }))
        .sort(bySlot),
    };
  }
  if (!session) return session;

  switch (action.type) {
    case 'participant': {
      const incoming = {
        ...action.participant,
        lastSeen: toLocal(action.participant.lastSeen, session.clockOffset),
      };
      const others = session.participants.filter((p) => p.id !== incoming.id);
      return { ...session, participants: [...others, incoming].sort(bySlot) };
    }
    case 'position': {
      const { participantId, point, stored } = action.event;
      return {
        ...session,
        participants: session.participants.map((p) =>
          p.id === participantId
            ? {
                ...p,
                online: true,
                sharing: true,
                lastSeen: Date.now(),
                lastPosition: point,
                points: stored ? [...p.points, point] : p.points,
              }
            : p,
        ),
      };
    }
    case 'status': {
      const { participantId, online, sharing, lastSeen } = action.event;
      return {
        ...session,
        participants: session.participants.map((p) =>
          p.id === participantId
            ? { ...p, online, sharing, lastSeen: toLocal(lastSeen, session.clockOffset) ?? p.lastSeen }
            : p,
        ),
      };
    }
  }
}

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Liga-se à sessão e mantém o estado sincronizado em tempo real. */
export function useSession(creds: StoredSession, onGone: (reason: GoneReason) => void) {
  const [session, dispatch] = useReducer(reducer, null);
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Client | null>(null);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  useEffect(() => {
    const socket: Client = io({ auth: { code: creds.code, token: creds.token } });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') onGoneRef.current('unauthorized');
    });
    socket.on('state', (state) => dispatch({ type: 'state', state }));
    socket.on('participant', (participant) => dispatch({ type: 'participant', participant }));
    socket.on('position', (event) => dispatch({ type: 'position', event }));
    socket.on('status', (event) => dispatch({ type: 'status', event }));
    socket.on('ended', (event) => {
      onGoneRef.current(
        event.reason === 'expired'
          ? 'expired'
          : event.by === creds.participantId
            ? 'ended-by-me'
            : 'ended-by-friend',
      );
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [creds.code, creds.token, creds.participantId]);

  const sendPosition = useCallback((point: TrackPoint) => {
    socketRef.current?.emit('position', point);
  }, []);
  const sendSharing = useCallback((active: boolean) => {
    socketRef.current?.emit('sharing', active);
  }, []);
  const sendHeartbeat = useCallback(() => {
    socketRef.current?.emit('heartbeat');
  }, []);
  const endSession = useCallback(() => {
    socketRef.current?.emit('end');
  }, []);

  return { session, connected, sendPosition, sendSharing, sendHeartbeat, endSession };
}
