/** Alfabeto sem caracteres ambíguos (0/O, 1/I). 32 símbolos = 5 bits por carácter. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 10 caracteres = 50 bits de entropia: impraticável de adivinhar com limite de tentativas. */
export const CODE_LENGTH = 10;

/** Remove separadores e normaliza maiúsculas. Devolve null se o código não for válido. */
export function normalizeCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '');
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

/** Apresenta o código em dois grupos: ABCDE-FGHJK. */
export function formatCode(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/** Valida e limpa um nome de participante. Devolve null se for inválido. */
export function normalizeName(input: unknown, maxLength: number): string | null {
  if (typeof input !== 'string') return null;
  const name = input.replace(/\s+/g, ' ').trim();
  if (name.length === 0 || name.length > maxLength) return null;
  return name;
}
