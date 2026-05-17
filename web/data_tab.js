/**
 * data_tab.js — Odin Gold infrastructure layer overview for the Data tab.
 *
 * Renders a static layer table immediately on load, then tries a live fetch
 * from /api/odin/layers. If the endpoint responds, record counts are updated
 * dynamically. If it returns 404 or fails, the static fallback stays.
 *
 * Tab wiring: app.js TAB_META["data"] = "data-meta" (hidden span inside the
 * pane mirrors its textContent into the panel header chip when Data is active).
 */

// ── Static seed data (pre-computed gold Parquets for OKC/Moore demo) ──────────
const STATIC_LAYERS = [
  {
    icon:    "🏠",
    key:     "shelters",
    label:   "shelters",
    desc:    "Emergency shelters and Red Cross facilities",
    count:   257,
    status:  "ready",
  },
  {
    icon:    "🏥",
    key:     "hospitals",
    label:   "hospitals",
    desc:    "Hospitals and public health facilities",
    count:   312,
    status:  "ready",
  },
  {
    icon:    "🚒",
    key:     "fire_stations",
    label:   "fire_stations",
    desc:    "Fire stations and rescue units",
    count:   78,
    status:  "ready",
  },
  {
    icon:    "🚨",
    key:     "emergency_services",
    label:   "emergency_services",
    desc:    "Law enforcement, EMS, and emergency management",
    count:   160,
    status:  "ready",
  },
  {
    icon:    "⚡",
    key:     "utilities",
    label:   "utilities",
    desc:    "Power generation, substations, and critical utilities",
    count:   168,
    status:  "ready",
  },
  {
    icon:    "👥",
    key:     "vulnerable_populations",
    label:   "vulnerable_populations",
    desc:    "Electricity-dependent residents and high social-vuln tracts",
    count:   67,
    status:  "ready",
  },
  {
    icon:    "🚌",
    key:     "transit",
    label:   "transit",
    desc:    "Public transit stops (Embark OKC bus network)",
    count:   1421,
    status:  "ready",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function totalRecords(layers) {
  return layers.reduce((sum, l) => sum + l.count, 0);
}

/** Build a single <tr> for a layer row. */
function buildRow(layer) {
  const tr = document.createElement("tr");
  tr.dataset.layerKey = layer.key;
  tr.innerHTML = `
    <td>${layer.icon}</td>
    <td><span class="data-layer-name">${layer.label}</span></td>
    <td><span class="data-layer-desc">${layer.desc}</span></td>
    <td><span class="data-layer-count" data-count-key="${layer.key}">${layer.count.toLocaleString()}</span></td>
    <td><span class="data-status-badge">${layer.status}</span></td>
  `;
  return tr;
}

/** Populate the tbody and update the subtitle + hidden-meta span. */
function render(layers) {
  const tbody    = document.getElementById("data-layer-tbody");
  const subtitle = document.getElementById("data-subtitle");
  const meta     = document.getElementById("data-meta");
  if (!tbody) return;

  tbody.innerHTML = "";
  layers.forEach((layer) => tbody.appendChild(buildRow(layer)));

  const total = totalRecords(layers);
  const count = layers.length;
  if (subtitle) {
    subtitle.textContent = `${total.toLocaleString()} records · ${count} layers · built 2026-05-12`;
  }
  if (meta) {
    meta.textContent = `${count} layers`;
  }
}

/** Patch record counts in-place from a live API response without full re-render.
 *  Expects response shape: { layers: [{ key, count, status }, …] }
 */
function patchCounts(apiData) {
  if (!apiData || !Array.isArray(apiData.layers)) return;

  let liveTotal = 0;
  apiData.layers.forEach(({ key, count }) => {
    const span = document.querySelector(`[data-count-key="${key}"]`);
    if (span && typeof count === "number") {
      span.textContent = count.toLocaleString();
      liveTotal += count;
    }
  });

  // Update subtitle with live total
  const subtitle = document.getElementById("data-subtitle");
  if (subtitle && liveTotal > 0) {
    subtitle.textContent = `${liveTotal.toLocaleString()} records · ${apiData.layers.length} layers · built 2026-05-12`;
  }
}

// ── Live fetch (non-blocking) ─────────────────────────────────────────────────

async function tryLiveFetch() {
  try {
    const res = await fetch("/api/odin/layers", { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return;          // 404 or other error → keep static
    const data = await res.json();
    patchCounts(data);
  } catch {
    // Network error, timeout, or parse failure → static data stays, no noise
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

render(STATIC_LAYERS);
tryLiveFetch();
