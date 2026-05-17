// TE NIMS · FOB — Library tab
//
// Reads the read-only NIMS doctrine PDF corpus from /library and renders
// a categorized, filterable list. The agent's answers are grounded in
// this corpus, so making it visible to the operator is part of the
// "verified context delivery" thesis — they can see what doctrine the
// model has at hand, click through to read the source, and trust the
// citations the agent emits.
//
// Pattern mirrors artifacts.js:
//   - Lazy fetch on first tab activation, refresh on subsequent opens
//   - Click a row → opens the PDF in a new browser window (Chrome's
//     native PDF viewer handles rendering / zoom / search). Modal-iframe
//     was rejected: PDFs are heavy and the operator wants real reading
//     UX, not a postage-stamp preview.

const TYPE_BADGE_CLASS = {
  "NIMS Doctrine":               "library-badge-nims",
  "National Response Framework": "library-badge-nrf",
  "NRF Support Annex":           "library-badge-nrf",
  "Emergency Support Functions": "library-badge-esf",
  "Other":                       "library-badge-other",
};

let _items = [];
let _loaded = false;

function $(id) { return document.getElementById(id); }

async function fetchLibrary() {
  const res = await fetch("/library", { cache: "no-store" });
  if (!res.ok) throw new Error(`/library → ${res.status}`);
  return res.json();
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function groupByCategory(items) {
  // Keep a stable category order so the operator sees the most-likely-
  // referenced doctrine at the top: NIMS first, then NRF, ESF, ICS forms.
  const order = [
    "NIMS Doctrine",
    "National Response Framework",
    "NRF Support Annex",
    "Emergency Support Functions",
    "Other",
  ];
  const groups = {};
  for (const it of items) {
    (groups[it.category] = groups[it.category] || []).push(it);
  }
  return order
    .filter((k) => groups[k] && groups[k].length)
    .map((k) => ({ category: k, items: groups[k] }));
}

function render(items) {
  const list  = $("library-list");
  const empty = $("library-empty");
  const meta  = $("library-meta");
  if (!list) return;

  list.innerHTML = "";
  if (items.length === 0) {
    list.hidden  = true;
    empty.hidden = false;
    if (meta) meta.textContent = "0 docs";
    return;
  }
  empty.hidden = true;
  list.hidden  = false;

  for (const group of groupByCategory(items)) {
    const section = document.createElement("section");
    section.className = "library-group";
    section.innerHTML = `<header class="library-group-head">${escapeHtml(group.category)} · ${group.items.length}</header>`;
    const ul = document.createElement("ul");
    ul.className = "library-group-list";
    for (const item of group.items) {
      const li = document.createElement("li");
      li.className = "library-row";
      const badgeClass = TYPE_BADGE_CLASS[group.category] || "library-badge-other";
      // "Indexed" badge if this PDF has already been prepped via /document/prepare
      // (persisted in localStorage by app.js attachDocuments). Means dragging
      // it in will skip the slow embed step.
      let indexed = false;
      try {
        const idx = JSON.parse(localStorage.getItem("te-fob-doc-index") || "[]");
        indexed = idx.some((d) => d.name === item.name);
      } catch { /* ignore */ }
      const indexedHtml = indexed
        ? `<span class="library-indexed" title="Already indexed for chat-with-document — drag to attach">●</span>`
        : "";
      li.innerHTML = `
        <button type="button" class="library-row-btn" data-name="${escapeHtml(item.name)}" draggable="true">
          <span class="library-badge ${badgeClass}">PDF</span>
          <span class="library-title">${escapeHtml(item.title)}</span>
          ${indexedHtml}
          <span class="library-size">${formatBytes(item.size)}</span>
        </button>`;
      const btn = li.querySelector(".library-row-btn");
      btn.addEventListener("click", () => openPdf(item));
      // Draggable into the chat composer for "chat with this document" RAG.
      // Drop handler in app.js routes application/x-te-document into the
      // pending-documents pipeline (POST /document/prepare → embed cache).
      btn.addEventListener("dragstart", (ev) => {
        if (!ev.dataTransfer) return;
        const absUrl = new URL(`/library/${encodeURIComponent(item.name)}`, window.location.href).href;
        ev.dataTransfer.setData("text/uri-list", absUrl);
        ev.dataTransfer.setData("text/plain",    absUrl);
        ev.dataTransfer.setData("application/x-te-document", JSON.stringify({
          name:     item.name,
          title:    item.title,
          category: item.category,
          url:      absUrl,
        }));
        ev.dataTransfer.effectAllowed = "copy";
      });
      ul.appendChild(li);
    }
    section.appendChild(ul);
    list.appendChild(section);
  }
  if (meta) meta.textContent = `${items.length} doc${items.length === 1 ? "" : "s"}`;

  // Mirror to tab-meta-display when this tab is active
  const display = $("tab-meta-display");
  const active = document.querySelector(".tab.active")?.dataset.tab;
  if (display && active === "library") {
    display.textContent = meta.textContent;
  }
}

function openPdf(item) {
  const url = `/library/${encodeURIComponent(item.name)}`;
  // Open in a new browser window so the operator gets Chrome's native
  // PDF viewer (zoom, search, page nav). The Chrome --app= window stays
  // focused on the chat; the doctrine reader is its own window.
  window.open(url, "_blank", "noopener,noreferrer");
}

function applyFilter() {
  const q = ($("library-search")?.value || "").trim().toLowerCase();
  if (!q) {
    render(_items);
    return;
  }
  const filtered = _items.filter((it) =>
    it.title.toLowerCase().includes(q) ||
    it.name.toLowerCase().includes(q) ||
    it.category.toLowerCase().includes(q)
  );
  render(filtered);
}

async function load(force = false) {
  if (_loaded && !force) return;
  try {
    const payload = await fetchLibrary();
    _items = payload.items || [];
    _loaded = true;
    render(_items);
  } catch (err) {
    console.warn("[library] fetch failed:", err);
  }
}

function init() {
  // Lazy: don't fetch until the tab is opened the first time. Saves a
  // 20MB-corpus filesystem walk on every page boot for operators who
  // never open the tab.
  document.querySelectorAll(".tab").forEach((tabBtn) => {
    tabBtn.addEventListener("click", () => {
      if (tabBtn.dataset.tab === "library") {
        load(false);   // first time only
      }
    });
  });
  // If the page reloads with library tab already active, fetch eagerly.
  if (document.querySelector('.tab.active')?.dataset.tab === "library") {
    load(false);
  }
  // Search filter
  $("library-search")?.addEventListener("input", applyFilter);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
