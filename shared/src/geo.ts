import { MAX_ACCURACY_M, MIN_MOVE_M } from './constants';
import type { TrackPoint } from './types';

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Distância em metros entre dois pontos (fórmula de haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Comprimento total de um trajeto, em metros. */
export function trackLengthMeters(points: readonly LatLng[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceMeters(points[i - 1]!, points[i]!);
  }
  return total;
}

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

export type PointVerdict =
  /** O ponto deve ser guardado no trajeto. */
  | 'store'
  /** Posição válida, mas demasiado perto do último ponto guardado (ruído de GPS parado). */
  | 'too-close'
  /** Precisão pior do que o limite: ignorar por completo. */
  | 'inaccurate'
  /** Coordenadas ou precisão inválidas. */
  | 'invalid';

export interface FilterOptions {
  maxAccuracyM?: number;
  minMoveM?: number;
}

/**
 * Decide o que fazer com uma nova posição, dado o último ponto guardado do trajeto.
 * É a única fonte de verdade da filtragem, usada pelo cliente e pelo servidor.
 */
export function evaluatePoint(
  last: LatLng | null | undefined,
  candidate: Pick<TrackPoint, 'lat' | 'lng' | 'accuracy'>,
  options: FilterOptions = {},
): PointVerdict {
  const maxAccuracy = options.maxAccuracyM ?? MAX_ACCURACY_M;
  const minMove = options.minMoveM ?? MIN_MOVE_M;

  if (!isValidCoordinate(candidate.lat, candidate.lng)) return 'invalid';
  if (
    typeof candidate.accuracy !== 'number' ||
    !Number.isFinite(candidate.accuracy) ||
    candidate.accuracy < 0
  ) {
    return 'invalid';
  }
  if (candidate.accuracy > maxAccuracy) return 'inaccurate';
  if (!last) return 'store';
  return distanceMeters(last, candidate) >= minMove ? 'store' : 'too-close';
}
