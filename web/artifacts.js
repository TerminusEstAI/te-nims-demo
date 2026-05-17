// TE NIMS · FOB — Artifacts panel
//
// Displays every image artifact produced during this session: charts (from
// the agent's plot_generate tool), maps (from map_generate), viz_tools.py
// PNGs, and uploaded photos. Server side scans /tmp/severian-charts/,
// /tmp/te-viz/, /tmp/severian-maps/, and /tmp/severian-uploads/ — see
// serve.py:_list_artifacts.
//
// Pattern mirrors chain.js: lazy-load, render on tab activation, click
// thumbnail → modal lightbox.

const REFRESH_INTERVAL_MS = 5000;
const TYPE_LABELS = {
  chart:  "chart",
  viz:    "viz",
  map:    "map",
  upload: "upload",
  doc:    "doc",
};

let _refreshTimer = null;
let _lastFingerprint = "";

// ── Client-side upload artifacts ────────────────────────────────────────
// Files dropped into the composer or pulled from the mobile QR upload
// endpoint are not in any ARTIFACT_DIRS scanned by the server, so we
// track them here on the client. Persisted to sessionStorage so they
// survive tab reloads within the same browser session.
const UPLOAD_STORAGE_KEY = "te-fob-upload-artifacts";
let _uploadArtifacts = [];
try {
  const raw = sessionStorage.getItem(UPLOAD_STORAGE_KEY);
  if (raw) _uploadArtifacts = JSON.parse(raw) || [];
} catch (e) {
  console.warn("[artifacts] failed to restore upload artifacts:", e);
  _uploadArtifacts = [];
}

function _persistUploads() {
  try {
    // Object URLs (blob:…) don't survive a reload; strip them when persisting.
    const safe = _uploadArtifacts.map(u => ({
      ...u,
      url: u.url && u.url.startsWith("blob:") ? null : u.url,
    })).filter(u => u.url);   // drop entries with no durable URL
    sessionStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(safe));
  } catch (e) {
    /* sessionStorage full / disabled — non-fatal */
  }
}

/**
 * Register an uploaded file as an artifact so it shows in the Artifacts tab.
 *
 * @param {object} meta
 * @param {string} meta.name  filename
 * @param {string} meta.url   /session-upload/<name>, /artifacts/<id>, or blob: URL
 * @param {string} [meta.mime]  MIME type (image/png, application/pdf, …)
 * @param {number} [meta.size]  file size in bytes
 * @param {string} [meta.source]  "drag-drop" | "browse" | "mobile" | "paste"
 */
export function addUploadArtifact(meta) {
  if (!meta || !meta.name || !meta.url) {
    throw new Error("addUploadArtifact requires {name, url}");
  }
  // Dedupe by (name, url) — same file dragged twice shouldn't double-count.
  const dupe = _uploadArtifacts.find(u => u.name === meta.name && u.url === meta.url);
  if (dupe) return dupe.id;

  const id = `upload-client:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    type: "upload",
    name: meta.name,
    url:  meta.url,
    mime: meta.mime || "application/octet-stream",
    size: meta.size || 0,
    mtime: Date.now() / 1000,
    source: meta.source || "client",
    _clientUpload: true,
  };
  _uploadArtifacts.unshift(entry);
  _persistUploads();
  // Force re-render so the new thumb appears immediately.
  refresh({ force: true }).catch((e) => console.warn("[artifacts] refresh:", e));
  return id;
}

async function fetchArtifacts() {
  const res = await fetch("/artifacts", { cache: "no-store" });
  if (!res.ok) throw new Error(`/artifacts → ${res.status}`);
  return res.json();
}

function fingerprint(items) {
  // ids + mtimes are enough — lets us skip re-rendering when nothing changed
  return items.map(i => `${i.id}@${i.mtime}`).join("|");
}

function relativeTime(mtime) {
  const ageSec = (Date.now() / 1000) - mtime;
  if (ageSec < 60)        return `${Math.round(ageSec)}s ago`;
  if (ageSec < 3600)      return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400)     return `${Math.round(ageSec / 3600)}h ago`;
  return new Date(mtime * 1000).toISOString().slice(0, 10);
}

function makeThumb(item) {
  const card = document.createElement("button");
  card.className = "artifact-thumb";
  card.type = "button";
  card.dataset.artifactId = item.id;
  card.setAttribute("aria-label", `${item.type}: ${item.name}`);
  card.draggable = true;

  // Client-side uploads carry their own URL (/session-upload/<name> or blob:);
  // server-scanned artifacts route via /artifacts/<id>.
  const url = item._clientUpload ? item.url : `/artifacts/${encodeURIComponent(item.id)}`;
  const isImage = (item.mime || "").startsWith("image/") ||
                  /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.name || "");

  if (item.type === "doc") {
    // Document artifact — show an icon + title instead of an image thumbnail
    const icon = document.createElement("div");
    icon.className = "artifact-doc-icon";
    icon.textContent = "📄";
    const titleEl = document.createElement("div");
    titleEl.className = "artifact-doc-title";
    // Strip leading timestamp and extension for a cleaner display label
    titleEl.textContent = item.name.replace(/^\d+-/, "").replace(/\.html$/, "").replace(/-/g, " ");
    card.appendChild(icon);
    card.appendChild(titleEl);
  } else if (item._clientUpload && !isImage) {
    // Non-image upload (PDF, csv, txt, …) — show a file icon + name + download link
    const icon = document.createElement("div");
    icon.className = "artifact-doc-icon";
    icon.textContent = "📎";
    const titleEl = document.createElement("div");
    titleEl.className = "artifact-doc-title";
    titleEl.textContent = item.name;
    card.appendChild(icon);
    card.appendChild(titleEl);
  } else {
    const img = document.createElement("img");
    img.src = url;
    img.alt = item.name;
    img.loading = "lazy";
    img.draggable = false;
    card.appendChild(img);
  }

  const label = document.createElement("div");
  label.className = "artifact-label";
  const typeBadge = document.createElement("span");
  typeBadge.className = `artifact-type artifact-type-${item.type}`;
  typeBadge.textContent = TYPE_LABELS[item.type] || item.type;
  const name = document.createElement("span");
  name.className = "artifact-name";
  name.textContent = item.name;
  const time = document.createElement("span");
  time.className = "artifact-time";
  time.textContent = relativeTime(item.mtime);

  label.appendChild(typeBadge);
  label.appendChild(name);
  label.appendChild(time);

  card.appendChild(label);

  card.addEventListener("click", () => openModal(item, { url, isImage }));
  card.addEventListener("dragstart", (ev) => {
    if (!ev.dataTransfer) return;
    const absUrl = new URL(url, window.location.href).href;
    ev.dataTransfer.setData("text/uri-list", absUrl);
    ev.dataTransfer.setData("text/plain",    absUrl);
    ev.dataTransfer.setData("application/x-te-artifact", JSON.stringify({
      id:   item.id,
      name: item.name,
      type: item.type,
      mime: item.mime || "",
      url:  absUrl,
    }));
    ev.dataTransfer.effectAllowed = "copy";
  });

  // Show "drag to chat" hint on hover
  card.title = card.title || "Drag to chat to attach";
  return card;
}

function openModal(item, opts = {}) {
  const itemUrl = opts.url || (item._clientUpload ? item.url : `/artifacts/${encodeURIComponent(item.id)}`);
  const itemIsImage = opts.isImage !== undefined
    ? opts.isImage
    : (item.mime || "").startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.name || "");

  if (item.type === "doc") {
    window.open(itemUrl, "_blank", "noopener,noreferrer");
    return;
  }
  // Non-image uploads — open in a new tab so the browser handles PDF/text/etc.
  if (item._clientUpload && !itemIsImage) {
    window.open(itemUrl, "_blank", "noopener,noreferrer");
    return;
  }
  const modal   = $("artifact-modal");
  const img     = $("artifact-modal-img");
  const caption = $("artifact-modal-caption");
  if (!modal || !img || !caption) return;
  img.src = itemUrl;
  img.alt = item.name;
  caption.textContent = `${TYPE_LABELS[item.type] || item.type} · ${item.name} · ${relativeTime(item.mtime)} · ${formatBytes(item.size)}`;
  modal.hidden = false;
}

// Open the same modal directly from a URL — used when an inline <img> in
// a chat message is clicked. We don't have the full item record there
// (no id/mtime/size), just the src + alt text from marked.js, so the
// caption is best-effort.
export function openArtifactUrl(url, caption = "") {
  const modal   = $("artifact-modal");
  const img     = $("artifact-modal-img");
  const cap     = $("artifact-modal-caption");
  if (!modal || !img || !cap) return;
  img.src = url;
  img.alt = caption || "artifact";
  cap.textContent = caption || url;
  modal.hidden = false;
}

function closeModal() {
  const modal = $("artifact-modal");
  if (!modal) return;
  modal.hidden = true;
  $("artifact-modal-img").src = "";
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function refresh({ force = false } = {}) {
  let payload;
  try {
    payload = await fetchArtifacts();
  } catch (err) {
    console.warn("[artifacts] fetch failed:", err);
    payload = { items: [] };
  }
  // Merge server-scanned artifacts with client-side upload artifacts.
  // Server's `upload` entries (mobile uploads written to severian-uploads/)
  // dedupe against client entries by basename to avoid double-listing.
  const serverItems = payload.items || [];
  const serverNames = new Set(serverItems.filter(s => s.type === "upload").map(s => s.name));
  const clientItems = _uploadArtifacts.filter(c => !serverNames.has(c.name));
  const items = [...clientItems, ...serverItems]
    .sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const fp = fingerprint(items);
  if (!force && fp === _lastFingerprint) return;   // nothing new
  _lastFingerprint = fp;

  const grid    = $("artifacts-grid");
  const empty   = $("artifacts-empty");
  const meta    = $("artifacts-meta");
  if (!grid || !empty || !meta) return;

  meta.textContent = `${items.length} artifact${items.length === 1 ? "" : "s"}`;

  if (items.length === 0) {
    grid.hidden = true;
    grid.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  grid.hidden = false;
  grid.innerHTML = "";   // simple full re-render — ~ms even at 100 items
  for (const item of items) {
    grid.appendChild(makeThumb(item));
  }

  // Mirror tab-meta-display when the artifacts tab is active so the panel
  // header chip matches the count.
  const display = $("tab-meta-display");
  const active = document.querySelector(".tab.active")?.dataset.tab;
  if (display && active === "artifacts") {
    display.textContent = meta.textContent;
  }
}

function startPolling() {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
}

function stopPolling() {
  if (!_refreshTimer) return;
  clearInterval(_refreshTimer);
  _refreshTimer = null;
}

// ── Wire up ─────────────────────────────────────────────────────────────
function init() {
  // Initial load (don't wait for tab activation — tiny payload)
  refresh({ force: true });

  // Poll only while the artifacts tab is active to avoid wasting
  // bandwidth/CPU when the operator is reading the chat or filling a form.
  document.querySelectorAll(".tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      const target = tabBtn.dataset.tab;
      if (target === "artifacts") {
        refresh({ force: true });
        startPolling();
      } else {
        stopPolling();
      }
    });
  });

  // Modal close + popout handlers
  const modal = $("artifact-modal");
  $("artifact-modal-close")?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (ev) => {
    if (ev.target === modal) closeModal();    // click backdrop = close
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && modal && !modal.hidden) closeModal();
  });
  // Pop out — open the image alone in a new window so the operator can
  // resize, zoom, or drag-out to a second monitor. Reads the current
  // <img>.src so it works for both Artifacts-tab thumbs and inline chat
  // images that route through openArtifactUrl.
  $("artifact-modal-popout")?.addEventListener("click", () => {
    const src = $("artifact-modal-img")?.src;
    if (!src) return;
    window.open(src, "_blank", "noopener,noreferrer");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Export for tests / app.js coordination
export { refresh as refreshArtifacts, openModal as openArtifact };
