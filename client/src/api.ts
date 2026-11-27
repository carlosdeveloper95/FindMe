import type { ApiErrorCode, JoinResponse } from '@findme/shared';

export class ApiError extends Error {
  constructor(public readonly code: ApiErrorCode | 'network' | 'internal') {
    super(code);
  }
}

const MESSAGES: Record<ApiError['code'], string> = {
  invalid_name: 'Escreve um nome com 1 a 24 caracteres.',
  invalid_code: 'Esse código não é válido. Confirma os 10 caracteres.',
  not_found: 'Não encontrámos essa sessão. Pode ter terminado ou expirado.',
  full: 'Esta sessão já tem duas pessoas.',
  rate_limited: 'Demasiadas tentativas. Espera um minuto e tenta outra vez.',
  network: 'Sem ligação ao servidor. Verifica a internet e tenta outra vez.',
  internal: 'Algo correu mal no servidor. Tenta outra vez.',
};

export const errorMessage = (err: unknown): string =>
  MESSAGES[err instanceof ApiError ? err.code : 'internal'];

async function post(path: string, body: unknown): Promise<JoinResponse> {
  let res: globalThis.Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network');
  }
  const data = (await res.json().catch(() => null)) as (JoinResponse & { error?: string }) | null;
  if (!res.ok || !data) {
    const code = data?.error;
    throw new ApiError(code && code in MESSAGES ? (code as ApiErrorCode) : 'internal');
  }
  return data;
}

export const createSession = (name: string) => post('/api/sessions', { name });

export const joinSession = (code: string, name: string) =>
  post(`/api/sessions/${encodeURIComponent(code)}/join`, { name });
