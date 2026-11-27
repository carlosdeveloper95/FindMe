/** Um ponto do trajeto. `ts` em milissegundos desde a época Unix. */
export interface TrackPoint {
  lat: number;
  lng: number;
  accuracy: number;
  ts: number;
}

export interface ParticipantInfo {
  id: string;
  name: string;
  color: string;
  /** 0 = quem criou a sessão, 1 = quem entrou pelo convite. */
  slot: number;
}

export interface ParticipantStatus {
  /** Tem pelo menos uma ligação aberta ao servidor. */
  online: boolean;
  /** Está a partilhar a localização neste momento. */
  sharing: boolean;
  /** Último sinal de vida (posição ou heartbeat). */
  lastSeen: number | null;
}

export interface ParticipantState extends ParticipantInfo, ParticipantStatus {
  /** Posição mais recente (pode não fazer parte do trajeto guardado). */
  lastPosition: TrackPoint | null;
  /** Trajeto completo desde o início da sessão. */
  points: TrackPoint[];
}

export interface SessionState {
  code: string;
  createdAt: number;
  expiresAt: number;
  /** Relógio do servidor, para o cliente converter os `lastSeen` para o seu relógio. */
  serverNow: number;
  /** Id do participante a quem este estado foi enviado. */
  me: string;
  participants: ParticipantState[];
}

/** Resposta do REST ao criar ou entrar numa sessão. */
export interface JoinResponse {
  code: string;
  expiresAt: number;
  participant: ParticipantInfo;
  /** Segredo do participante; só é devolvido uma vez e fica guardado no dispositivo. */
  token: string;
}

export type ApiErrorCode =
  | 'invalid_name'
  | 'invalid_code'
  | 'not_found'
  | 'full'
  | 'rate_limited';

export interface PositionEvent {
  participantId: string;
  point: TrackPoint;
  /** true se o ponto foi acrescentado ao trajeto guardado. */
  stored: boolean;
}

export interface StatusEvent extends ParticipantStatus {
  participantId: string;
}

export interface EndedEvent {
  reason: 'ended' | 'expired';
  by?: string;
}

export interface ServerToClientEvents {
  state: (state: SessionState) => void;
  participant: (participant: ParticipantState) => void;
  position: (event: PositionEvent) => void;
  status: (event: StatusEvent) => void;
  ended: (event: EndedEvent) => void;
}

export interface ClientToServerEvents {
  position: (point: TrackPoint) => void;
  sharing: (active: boolean) => void;
  heartbeat: () => void;
  end: (ack?: () => void) => void;
}

export interface SocketAuth {
  code: string;
  token: string;
}
