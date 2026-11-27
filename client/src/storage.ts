/** Credenciais da sessão em curso, guardadas no dispositivo para sobreviver a recarregamentos. */
export interface StoredSession {
  code: string;
  token: string;
  participantId: string;
}

const SESSION_KEY = 'findme:session';
const NAME_KEY = 'findme:name';
const sharingKey = (code: string) => `findme:sharing:${code}`;

// O armazenamento pode falhar (modo privado, quota); a app tem de funcionar na mesma.
function read(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(storage: Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* ignorar */
  }
}

export function loadSession(): StoredSession | null {
  const raw = read(localStorage, SESSION_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof value.code === 'string' &&
      typeof value.token === 'string' &&
      typeof value.participantId === 'string'
    ) {
      return { code: value.code, token: value.token, participantId: value.participantId };
    }
  } catch {
    /* dados corrompidos */
  }
  return null;
}

export function saveSession(session: StoredSession): void {
  write(localStorage, SESSION_KEY, JSON.stringify(session));
}

export function clearSession(code: string): void {
  write(localStorage, SESSION_KEY, null);
  write(sessionStorage, sharingKey(code), null);
}

export const loadName = (): string => read(localStorage, NAME_KEY) ?? '';
export const saveName = (name: string): void => write(localStorage, NAME_KEY, name);

/**
 * Lembra, só neste separador, que o utilizador já autorizou a partilha nesta sessão,
 * para a retomar depois de recarregar a página.
 */
export const loadSharing = (code: string): boolean => read(sessionStorage, sharingKey(code)) === '1';
export const saveSharing = (code: string, active: boolean): void =>
  write(sessionStorage, sharingKey(code), active ? '1' : null);
