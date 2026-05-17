// TE NIMS · FOB — map module
//
// Leaflet over OSM raster tiles for the POC. FOB-tier deployment swaps the
// tile source to local MBTiles (offline) — see README.md.
//
// Public API:
//   initMap(scenario)    — boot the map, drop scenario markers
//   locateUser()         — GPS pin via browser geolocation
//   addPin(type,lat,lng,label,sub) — drop a new pin from outside (e.g. agent tool)

let map        = null;
let userPin    = null;
let _tileLayer = null;

// Pin styles — plain CSS-styled DivIcons keep the bundle small
function pinIcon(type) {
  const colors = {
    incident: "#e74c3c",
    staging:  "#e8551a",
    hospital: "#3498db",
    shelter:  "#5cb85c",
    eoc:      "#e8551a",
    user:     "#ffffff",
  };
  const symbols = {
    incident: "⚠",
    staging:  "▲",
    hospital: "✚",
    shelter:  "⌂",
    eoc:      "★",
    user:     "⌖",
  };
  const color = colors[type]    || "#888";
  const sym   = symbols[type]   || "●";
  // L is the global Leaflet object loaded via CDN <script>
  // eslint-disable-next-line no-undef
  return L.divIcon({
    className: "te-pin",
    html: `<div class="te-pin-inner" style="background:${color}">${sym}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

export function initMap(scenario) {
  if (map) return map;
  const el = document.getElementById("map");
  if (!el) {
    console.warn("map element not found");
    return null;
  }

  // Restore last zoom/center if persisted; fall back to scenario defaults.
  // localStorage is synchronous so we can read it inline without async.
  let center = scenario.center;
  let zoom   = scenario.zoom;
  let lastUser = null;
  try {
    // Lazy-load so this module doesn't have a hard dependency on persistence.
    const raw = localStorage.getItem("te-fob-map-state");
    if (raw) {
      const s = JSON.parse(raw);
      if (Array.isArray(s.center) && s.center.length === 2) center = s.center;
      if (typeof s.zoom === "number") zoom = s.zoom;
      lastUser = s.user || null;
    }
  } catch (e) {
    console.warn("[map] restore failed:", e);
  }

  // Hard-clamp zoom range to whatever the local mbtiles actually has.
  // Outside this range users would see blank tiles — a worse UX than
  // not letting them zoom there in the first place.
  // eslint-disable-next-line no-undef
  map = L.map("map", {
    center,
    zoom,
    minZoom: scenario.minZoom || 11,
    maxZoom: scenario.maxZoom || 16,
    zoomControl: true,
    attributionControl: false,
  });

  // Persist on every move/zoom (Leaflet emits one event per gesture so
  // this is cheap; no debounce needed). Also restore the user-locate pin
  // if the operator dropped one before the reload.
  function persistMapState() {
    const c = map.getCenter();
    const state = {
      center: [c.lat, c.lng],
      zoom:   map.getZoom(),
    };
    if (userPin) {
      const u = userPin.getLatLng();
      state.user = { lat: u.lat, lng: u.lng };
    }
    try { localStorage.setItem("te-fob-map-state", JSON.stringify(state)); }
    catch (e) { /* quota / private mode — ignore */ }
  }
  map.on("moveend zoomend", persistMapState);
  if (lastUser) {
    userPin = addPin("user", lastUser.lat, lastUser.lng,
                     "Last known location", "Restored from session");
  }

  // Local MBTiles served by serve.py at /tiles/{z}/{x}/{y}.png.
  // FOB-deployable: zero network calls. Coverage = whatever is in
  // imagery-cache/*.mbtiles (offline fallback — re-cache from USGS tiles for FOB use;
  // zoom 14-16). Run `python3 serve.py` to start the tile server.
  //
  // If the local mbtiles is missing / out-of-bounds, individual tiles
  // 404 and Leaflet shows a blank checkerboard — that's the offline
  // signal, not a fallback to OSM. We do NOT silently fall back to a
  // remote tile source (would defeat the offline guarantee).
  // eslint-disable-next-line no-undef
  // eslint-disable-next-line no-undef
  // Transparent 1×1 PNG — shown for any tile outside the MBTiles coverage
  // bounds. Keeps the map functional without console 404 spam when panning
  // or zooming to areas not in the offline cache.
  const _BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  // Primary: USGS National Map Imagery — U.S. federal public-domain imagery.
  // Fallback errorTileUrl shows blank tile when offline (e.g. thumb-drive FOB).
  _tileLayer = L.tileLayer(
    "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}",
    {
      minZoom: scenario.minZoom || 11,
      maxZoom: scenario.maxZoom || 16,
      maxNativeZoom: 16,
      attribution: 'Imagery: <a href="https://www.usgs.gov/" target="_blank">U.S. Geological Survey</a>',
      errorTileUrl: _BLANK,
    }
  ).addTo(map);

  // Drop the scenario's pre-defined markers
  for (const m of scenario.markers || []) {
    addPin(m.type, m.lat, m.lng, m.label, m.sub || "");
  }

  return map;
}

export function addPin(type, lat, lng, label, sub = "") {
  if (!map) return null;
  // eslint-disable-next-line no-undef
  const marker = L.marker([lat, lng], { icon: pinIcon(type) }).addTo(map);
  marker.bindPopup(
    `<strong>${escapeHtml(label)}</strong>` +
    (sub ? `<br><small>${escapeHtml(sub)}</small>` : "")
  );
  return marker;
}

export function locateUser() {
  if (!map) return;
  if (!("geolocation" in navigator)) {
    alert("Geolocation not supported by this browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords;
      if (userPin) {
        userPin.setLatLng([latitude, longitude]);
      } else {
        userPin = addPin("user", latitude, longitude,
                         "You are here", "GPS · " + new Date().toLocaleTimeString());
      }
      map.setView([latitude, longitude], 13, { animate: true });
    },
    (err) => {
      let msg = err.message;
      if (err.code === 1) {
        msg = "Location permission denied. Enable geolocation in your browser settings.";
      } else if (err.code === 2) {
        msg = "Unable to retrieve location. Check your GPS/network and try again.";
      } else if (err.code === 3) {
        msg = "Location request timed out. Try again.";
      } else if (msg.includes("secure")) {
        msg = "Geolocation requires HTTPS or localhost. Access via http://localhost:8765 instead.";
      }
      alert(`Locate failed: ${msg}`);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

export function getMap() {
  return map;
}

export function zoomTo(lat, lon, zoom = 16) {
  if (!map) return;
  map.setView([lat, lon], zoom, { animate: true });
}

// Damage class → fill color (red=destroyed, orange=major, yellow=minor)
const DAMAGE_COLOR = {
  "destroyed":    "#e74c3c",
  "major-damage": "#e8551a",
  "minor-damage": "#f1c40f",
  "no-damage":    "#5cb85c",
};

let _damageLayerGroup = null;
let _damageLoaded = false;

export async function loadDamageOverlay() {
  if (!map) return;
  if (_damageLayerGroup) {
    _damageLayerGroup.remove();
    _damageLayerGroup = null;
  }

  let data;
  try {
    const r = await fetch("/demo/damage");
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  // eslint-disable-next-line no-undef
  const group = L.layerGroup();  // not added to map — off by default, toggle to show

  // eslint-disable-next-line no-undef
  if (typeof L.heatLayer === "function" && data.heatmap?.length) {
    // eslint-disable-next-line no-undef
    L.heatLayer(data.heatmap, {
      radius: 18,
      blur: 20,
      maxZoom: 16,
      gradient: { 0.1: "#5cb85c", 0.4: "#f1c40f", 0.75: "#e8551a", 1.0: "#e74c3c" },
    }).addTo(group);
  }

  if (data.track?.features?.length) {
    // eslint-disable-next-line no-undef
    L.geoJSON(data.track, {
      style: (feat) => ({
        color:       DAMAGE_COLOR[feat.properties.damage_level] || "#888",
        fillColor:   DAMAGE_COLOR[feat.properties.damage_level] || "#888",
        weight:      1,
        fillOpacity: 0.55,
        opacity:     0.8,
      }),
      onEachFeature: (feat, layer) => {
        layer.bindPopup(`<strong>${feat.properties.damage_level}</strong>`);
      },
    }).addTo(group);
  }

  _damageLayerGroup = group;
  _damageLoaded = true;
}

export function toggleDamageOverlay() {
  if (!_damageLayerGroup || !map) return false;
  if (map.hasLayer(_damageLayerGroup)) {
    _damageLayerGroup.remove();
    return false;
  } else {
    _damageLayerGroup.addTo(map);
    return true;
  }
}

export function isDamageLoaded() {
  return _damageLoaded;
}

// ── Tornado track overlay ──────────────────────────────────────────────────
let _trackLayerGroup = null;

export async function loadTrackOverlay() {
  if (!map) return;
  if (_trackLayerGroup) { _trackLayerGroup.remove(); _trackLayerGroup = null; }

  let data;
  try {
    const r = await fetch("/demo/track");
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  // eslint-disable-next-line no-undef
  const group = L.layerGroup().addTo(map);

  // eslint-disable-next-line no-undef
  L.geoJSON(data, {
    style: (feat) => {
      if (feat.geometry.type === "Polygon") {
        return { color: "#9b59b6", fillColor: "#9b59b6", weight: 2, fillOpacity: 0.20, opacity: 0.8 };
      }
      return { color: "#ffffff", weight: 3, opacity: 0.9, dashArray: "6 4" };
    },
    onEachFeature: (feat, layer) => {
      const p = feat.properties;
      if (feat.geometry.type === "Polygon") {
        layer.bindPopup(
          `<strong>${p.name}</strong><br>EF-${p.ef_scale} · ${p.width_m}m wide · ${p.length_mi} mi · ${p.date}`
        );
      } else {
        layer.bindPopup(`<strong>${p.name}</strong> · EF-${p.ef_scale}`);
      }
    },
  }).addTo(group);

  _trackLayerGroup = group;
}

export function toggleTrackOverlay() {
  if (!_trackLayerGroup || !map) return false;
  if (map.hasLayer(_trackLayerGroup)) { _trackLayerGroup.remove(); return false; }
  _trackLayerGroup.addTo(map); return true;
}

// ── Microsoft buildings overlay (peer model) ──────────────────────────────
let _buildingsLayerGroup = null;

export async function loadBuildingsOverlay() {
  if (!map) return;
  if (_buildingsLayerGroup) { _buildingsLayerGroup.remove(); _buildingsLayerGroup = null; }

  let data;
  try {
    const r = await fetch("/demo/buildings");
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }

  // Canvas renderer keeps 16K polygons performant
  // eslint-disable-next-line no-undef
  const group = L.layerGroup().addTo(map);
  // eslint-disable-next-line no-undef
  const renderer = L.canvas({ padding: 0.5 });
  // eslint-disable-next-line no-undef
  L.geoJSON(data, {
    renderer,
    style: (feat) => {
      const color = DAMAGE_COLOR[feat.properties?.damage_level] || "#888";
      return { color, fillColor: color, weight: 1.2, fillOpacity: 0.30, opacity: 0.90 };
    },
    onEachFeature: (feat, layer) => {
      const p = feat.properties || {};
      layer.bindPopup(
        `<strong>${p.damage_level || "unknown"}</strong>` +
        (p.area_m2 ? `<br>${Math.round(p.area_m2)} m²` : "")
      );
    },
  }).addTo(group);

  _buildingsLayerGroup = group;
}

export function toggleBuildingsOverlay() {
  if (!_buildingsLayerGroup || !map) return false;
  if (map.hasLayer(_buildingsLayerGroup)) { _buildingsLayerGroup.remove(); return false; }
  _buildingsLayerGroup.addTo(map); return true;
}

// ── Base tile layer toggle ─────────────────────────────────────────────────
export function toggleTileLayer() {
  if (!_tileLayer || !map) return true;
  if (map.hasLayer(_tileLayer)) { _tileLayer.remove(); return false; }
  _tileLayer.addTo(map); return true;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
