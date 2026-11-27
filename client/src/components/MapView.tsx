import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import L from 'leaflet';
import type { TrackPoint } from '@findme/shared';

export interface MapPerson {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
  lastPosition: TrackPoint | null;
  /** Posição desatualizada (pausa ou offline): o marcador aparece esbatido. */
  stale: boolean;
}

export interface MapHandle {
  /** Centra o mapa na posição atual de uma pessoa. Devolve false se ainda não houver posição. */
  centerOn: (id: string) => boolean;
  /** Ajusta o zoom para caberem os trajetos todos. */
  fitAll: () => boolean;
}

interface Layers {
  line: L.Polyline;
  marker: L.Marker;
  accuracy: L.Circle;
  /** Chave do aspeto do marcador, para só o recriar quando muda. */
  iconKey: string;
}

const PORTUGAL: L.LatLngTuple = [39.6, -8.0];

/** O nome vem de outro utilizador: é inserido como texto, nunca como HTML. */
function buildIcon(person: MapPerson): L.DivIcon {
  const el = document.createElement('div');
  el.className = `pin${person.stale ? ' pin--stale' : ''}`;
  el.style.setProperty('--pin-color', person.color);
  const dot = document.createElement('span');
  dot.className = 'pin__dot';
  const label = document.createElement('span');
  label.className = 'pin__label';
  label.textContent = person.name;
  el.append(dot, label);
  return L.divIcon({ html: el, className: 'pin-wrap', iconSize: [0, 0] });
}

const toLatLng = (p: TrackPoint): L.LatLngTuple => [p.lat, p.lng];

export const MapView = forwardRef<MapHandle, { people: MapPerson[] }>(function MapView(
  { people },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layers = useRef(new Map<string, Layers>());
  const peopleRef = useRef(people);
  peopleRef.current = people;
  /** Quantas pessoas já tinham posição da última vez que o mapa se ajustou sozinho. */
  const fittedCount = useRef(0);

  const fitAll = (): boolean => {
    const map = mapRef.current;
    if (!map) return false;
    const all: L.LatLngTuple[] = [];
    for (const p of peopleRef.current) {
      for (const pt of p.points) all.push(toLatLng(pt));
      if (p.lastPosition) all.push(toLatLng(p.lastPosition));
    }
    if (all.length === 0) return false;
    const bounds = L.latLngBounds(all);
    if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
      map.setView(bounds.getCenter(), 16);
    } else {
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17 });
    }
    return true;
  };

  useImperativeHandle(ref, () => ({
    centerOn: (id) => {
      const person = peopleRef.current.find((p) => p.id === id);
      const map = mapRef.current;
      if (!person?.lastPosition || !map) return false;
      map.setView(toLatLng(person.lastPosition), Math.max(map.getZoom(), 16));
      return true;
    },
    fitAll,
  }));

  // Cria o mapa uma única vez.
  useEffect(() => {
    const map = L.map(container.current!, { zoomControl: false }).setView(PORTUGAL, 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    mapRef.current = map;

    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container.current!);

    return () => {
      observer.disconnect();
      map.remove();
      mapRef.current = null;
      layers.current.clear();
      fittedCount.current = 0;
    };
  }, []);

  // Sincroniza marcadores e linhas com o estado da sessão.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const seen = new Set<string>();
    for (const person of people) {
      seen.add(person.id);
      let entry = layers.current.get(person.id);
      if (!entry) {
        entry = {
          line: L.polyline([], {
            color: person.color,
            weight: 5,
            opacity: 0.85,
            lineJoin: 'round',
            lineCap: 'round',
          }).addTo(map),
          accuracy: L.circle(PORTUGAL, {
            radius: 0,
            color: person.color,
            weight: 1,
            opacity: 0.35,
            fillOpacity: 0.1,
            interactive: false,
          }),
          marker: L.marker(PORTUGAL, { icon: buildIcon(person), interactive: false, keyboard: false }),
          iconKey: '',
        };
        layers.current.set(person.id, entry);
      }

      // A linha termina na posição atual, para ligar o trajeto ao marcador.
      const path = person.points.map(toLatLng);
      if (person.lastPosition) path.push(toLatLng(person.lastPosition));
      entry.line.setLatLngs(path);

      if (person.lastPosition) {
        const at = toLatLng(person.lastPosition);
        entry.marker.setLatLng(at);
        entry.accuracy.setLatLng(at).setRadius(person.lastPosition.accuracy);
        if (!map.hasLayer(entry.marker)) {
          entry.accuracy.addTo(map);
          entry.marker.addTo(map);
        }
      }

      const iconKey = `${person.name}|${person.color}|${person.stale}`;
      if (iconKey !== entry.iconKey) {
        entry.marker.setIcon(buildIcon(person));
        entry.iconKey = iconKey;
      }
    }

    for (const [id, entry] of layers.current) {
      if (seen.has(id)) continue;
      entry.line.remove();
      entry.marker.remove();
      entry.accuracy.remove();
      layers.current.delete(id);
    }

    // Quando aparece a primeira posição de alguém, enquadra tudo automaticamente.
    const located = people.filter((p) => p.lastPosition).length;
    if (located > fittedCount.current) fitAll();
    fittedCount.current = located;
  }, [people]);

  return <div ref={container} className="map" aria-label="Mapa com as posições e os trajetos" />;
});
