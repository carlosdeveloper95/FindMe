import { useEffect, useRef, useState } from 'react';
import type { TrackPoint } from '@findme/shared';

export type GeoError = 'denied' | 'unavailable' | 'timeout' | 'unsupported';

/**
 * Segue a posição do dispositivo enquanto `active` for verdadeiro.
 * O pedido de permissão só acontece quando `active` passa a true, ou seja,
 * depois de o utilizador carregar em "Partilhar a minha localização".
 */
export function useGeolocation(active: boolean, onFix: (fix: TrackPoint) => void) {
  const [error, setError] = useState<GeoError | null>(null);
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;

  useEffect(() => {
    if (!active) return;
    if (!('geolocation' in navigator)) {
      setError('unsupported');
      return;
    }
    setError(null);
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null);
        onFixRef.current({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          ts: pos.timestamp,
        });
      },
      (err) => {
        setError(
          err.code === err.PERMISSION_DENIED
            ? 'denied'
            : err.code === err.TIMEOUT
              ? 'timeout'
              : 'unavailable',
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    // Ao pausar, o seguimento pára de imediato.
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);

  return { error, clearError: () => setError(null) };
}
