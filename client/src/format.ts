const decimal = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const time = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** 350 m · 1,2 km · 27 km */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return km < 100 ? `${decimal.format(km)} km` : `${Math.round(km)} km`;
}

export const formatTime = (ts: number): string => time.format(ts);

/** agora · há 12 s · há 3 min · há 2 h */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `há ${min} min`;
  return `há ${Math.round(min / 60)} h`;
}
