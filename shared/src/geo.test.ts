import { describe, expect, it } from 'vitest';
import { distanceMeters, evaluatePoint, isValidCoordinate, trackLengthMeters } from './geo';
import { formatCode, normalizeCode, normalizeName } from './code';

const lisboa = { lat: 38.7223, lng: -9.1393 };
const porto = { lat: 41.1579, lng: -8.6291 };

/** Desloca um ponto para norte o número de metros indicado. */
const north = (p: { lat: number; lng: number }, meters: number) => ({
  lat: p.lat + meters / 111_195,
  lng: p.lng,
});

describe('distanceMeters', () => {
  it('é zero para o mesmo ponto', () => {
    expect(distanceMeters(lisboa, lisboa)).toBe(0);
  });

  it('calcula Lisboa–Porto (~274 km)', () => {
    const d = distanceMeters(lisboa, porto);
    expect(d).toBeGreaterThan(272_000);
    expect(d).toBeLessThan(276_000);
  });

  it('é simétrica', () => {
    expect(distanceMeters(lisboa, porto)).toBeCloseTo(distanceMeters(porto, lisboa), 6);
  });

  it('um grau de latitude são ~111 km', () => {
    expect(distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111_195, -2);
  });

  it('funciona através do antimeridiano', () => {
    const d = distanceMeters({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 });
    expect(d).toBeCloseTo(111_195, -2);
  });
});

describe('trackLengthMeters', () => {
  it('é zero sem pontos ou com um só', () => {
    expect(trackLengthMeters([])).toBe(0);
    expect(trackLengthMeters([lisboa])).toBe(0);
  });

  it('soma os segmentos', () => {
    const track = [lisboa, north(lisboa, 100), north(lisboa, 250)];
    expect(trackLengthMeters(track)).toBeCloseTo(250, 0);
  });

  it('conta ida e volta', () => {
    const track = [lisboa, north(lisboa, 100), lisboa];
    expect(trackLengthMeters(track)).toBeCloseTo(200, 0);
  });
});

describe('evaluatePoint', () => {
  const fix = (p: { lat: number; lng: number }, accuracy = 10) => ({ ...p, accuracy });

  it('guarda o primeiro ponto', () => {
    expect(evaluatePoint(null, fix(lisboa))).toBe('store');
  });

  it('ignora pontos com precisão pior que 50 m', () => {
    expect(evaluatePoint(null, fix(lisboa, 50.1))).toBe('inaccurate');
    expect(evaluatePoint(lisboa, fix(north(lisboa, 500), 120))).toBe('inaccurate');
  });

  it('aceita precisão exatamente no limite', () => {
    expect(evaluatePoint(null, fix(lisboa, 50))).toBe('store');
  });

  it('não guarda quando a pessoa quase não se moveu', () => {
    expect(evaluatePoint(lisboa, fix(north(lisboa, 3)))).toBe('too-close');
    expect(evaluatePoint(lisboa, fix(lisboa))).toBe('too-close');
  });

  it('guarda quando a pessoa se moveu o suficiente', () => {
    expect(evaluatePoint(lisboa, fix(north(lisboa, 12)))).toBe('store');
  });

  it('respeita limites personalizados', () => {
    expect(evaluatePoint(lisboa, fix(north(lisboa, 12)), { minMoveM: 20 })).toBe('too-close');
    expect(evaluatePoint(null, fix(lisboa, 30), { maxAccuracyM: 20 })).toBe('inaccurate');
  });

  it('rejeita dados inválidos', () => {
    expect(evaluatePoint(null, { lat: 91, lng: 0, accuracy: 5 })).toBe('invalid');
    expect(evaluatePoint(null, { lat: 0, lng: 181, accuracy: 5 })).toBe('invalid');
    expect(evaluatePoint(null, { lat: NaN, lng: 0, accuracy: 5 })).toBe('invalid');
    expect(evaluatePoint(null, { lat: 0, lng: 0, accuracy: -1 })).toBe('invalid');
    expect(evaluatePoint(null, { lat: 0, lng: 0, accuracy: Infinity })).toBe('invalid');
    expect(evaluatePoint(null, { lat: '1', lng: 0, accuracy: 5 } as never)).toBe('invalid');
  });
});

describe('isValidCoordinate', () => {
  it('aceita os extremos e rejeita o resto', () => {
    expect(isValidCoordinate(90, 180)).toBe(true);
    expect(isValidCoordinate(-90, -180)).toBe(true);
    expect(isValidCoordinate(90.01, 0)).toBe(false);
    expect(isValidCoordinate(null, 0)).toBe(false);
  });
});

describe('códigos e nomes', () => {
  it('normaliza códigos com hífen, espaços e minúsculas', () => {
    expect(normalizeCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeCode(' ABCDE FGHJK ')).toBe('ABCDEFGHJK');
  });

  it('rejeita códigos com tamanho ou caracteres errados', () => {
    expect(normalizeCode('ABC')).toBeNull();
    expect(normalizeCode('ABCDE-FGHJ0')).toBeNull(); // 0 não pertence ao alfabeto
    expect(normalizeCode('ABCDE-FGHJKL')).toBeNull();
  });

  it('formata em dois grupos', () => {
    expect(formatCode('ABCDEFGHJK')).toBe('ABCDE-FGHJK');
  });

  it('valida nomes', () => {
    expect(normalizeName('  Ana   Maria ', 24)).toBe('Ana Maria');
    expect(normalizeName('   ', 24)).toBeNull();
    expect(normalizeName('x'.repeat(25), 24)).toBeNull();
    expect(normalizeName(42, 24)).toBeNull();
  });
});
