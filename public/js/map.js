// Thin wrapper around Leaflet (loaded globally from /vendor/leaflet/leaflet.js).

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

export function createRunMap(el, { followButton } = {}) {
  const L = window.L;
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([20, 0], 2);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const style = getComputedStyle(document.documentElement);
  const routeColor = style.getPropertyValue('--route').trim() || '#ff5a1f';

  const routeLayer = L.layerGroup().addTo(map);
  const splitLayer = L.layerGroup().addTo(map);
  let startMarker = null;
  const runner = L.marker([0, 0], {
    icon: L.divIcon({ className: '', html: '<div class="runner-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    interactive: false,
    keyboard: false,
  });
  let accuracy = null;

  let follow = true;
  let fitted = false;
  map.on('dragstart', () => setFollow(false));

  function setFollow(on) {
    follow = on;
    if (followButton) followButton.hidden = on;
  }
  followButton?.addEventListener('click', () => {
    setFollow(true);
    if (runner._map) map.setView(runner.getLatLng(), Math.max(map.getZoom(), 15));
  });
  setFollow(true);

  /**
   * @param {object[]} track cleanTrack() output (for the route + split markers)
   * @param {object|null} position latest raw position {lat, lon, acc}
   * @param {object} opts { live, unitMeters }
   */
  function update(track, position, { live = false, unitMeters = 1000 } = {}) {
    routeLayer.clearLayers();
    const segments = [];
    let current = null;
    for (const p of track) {
      if (!current || p.seg !== current.seg) segments.push((current = { seg: p.seg, pts: [] }));
      current.pts.push([p.lat, p.lon]);
    }
    for (const s of segments) {
      if (s.pts.length > 1) {
        L.polyline(s.pts, { color: routeColor, weight: 5, opacity: 0.9, lineJoin: 'round' }).addTo(routeLayer);
      }
    }

    if (track.length) {
      const start = [track[0].lat, track[0].lon];
      if (!startMarker) {
        startMarker = L.circleMarker(start, {
          radius: 7, color: '#fff', weight: 3, fillColor: '#16a34a', fillOpacity: 1,
        }).bindTooltip('Start').addTo(map);
      } else startMarker.setLatLng(start);
    }

    splitLayer.clearLayers();
    let mark = unitMeters;
    let n = 1;
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1];
      const b = track[i];
      while (b.d >= mark && b.d > a.d) {
        const f = (mark - a.d) / (b.d - a.d);
        const ll = [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
        L.marker(ll, {
          icon: L.divIcon({ className: 'split-label', html: String(n), iconSize: [22, 22] }),
          interactive: false,
          keyboard: false,
        }).addTo(splitLayer);
        mark += unitMeters;
        n++;
      }
    }

    if (position) {
      const ll = [position.lat, position.lon];
      runner.setLatLng(ll);
      if (!runner._map) runner.addTo(map);
      runner.getElement()?.firstElementChild?.classList.toggle('idle', !live);
      if (Number.isFinite(position.acc)) {
        if (!accuracy) {
          accuracy = L.circle(ll, { radius: position.acc, color: routeColor, weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
        } else accuracy.setLatLng(ll).setRadius(position.acc);
      }
      if (!fitted) {
        fitted = true;
        const all = track.map((p) => [p.lat, p.lon]);
        if (all.length > 1) map.fitBounds(L.latLngBounds(all).extend(ll), { padding: [30, 30], maxZoom: 16 });
        else map.setView(ll, 16);
      } else if (follow) {
        map.panTo(ll, { animate: true });
      }
    }
  }

  function invalidate() {
    map.invalidateSize();
  }

  return { update, invalidate, map };
}
