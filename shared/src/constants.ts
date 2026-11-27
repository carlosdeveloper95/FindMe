/** Pontos com precisão pior do que isto (em metros) são ignorados. */
export const MAX_ACCURACY_M = 50;

/** Distância mínima (em metros) ao último ponto guardado para registar um novo. */
export const MIN_MOVE_M = 8;

/** Sem sinais de vida há mais tempo do que isto, o participante aparece como offline. */
export const OFFLINE_AFTER_MS = 30_000;

/** Intervalo do sinal de vida enviado enquanto a partilha está ativa. */
export const HEARTBEAT_MS = 10_000;

/** As sessões (e todos os seus pontos) expiram ao fim de 24 horas. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_PARTICIPANTS = 2;

/** Cores atribuídas por ordem de entrada: quem cria fica azul, quem entra fica laranja. */
export const PARTICIPANT_COLORS = ['#2563eb', '#f97316'] as const;

export const NAME_MAX_LENGTH = 24;

/** Limite de pontos guardados por participante, para proteger o servidor. */
export const MAX_POINTS_PER_PARTICIPANT = 20_000;
