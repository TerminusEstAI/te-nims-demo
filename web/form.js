// TE NIMS · FOB — ICS forms panel
//
// Open → asks serve.py to open the PDF in the OS default app (Preview on
// macOS).  The ICS file watcher in serve.py detects saves from the external
// editor and auto-versions the file into saved-forms/ — every version also
// generates a VPO chain block with a pdf_url link to the saved file.

const $ = (id) => document.getElementById(id);

// Assigned by initFormsPanel so external callers can trigger a list refresh.
let _reloadForms = null;

// Modal: Save not available in web demo.
function _showWebDemoModal() {
  const existing = document.getElementById("te-web-demo-modal");
  if (existing) { existing.remove(); }
  const overlay = document.createElement("div");
  overlay.id = "te-web-demo-modal";
  overlay.innerHTML = `
    <div class="te-modal-backdrop"></div>
    <div class="te-modal-box" role="dialog" aria-modal="true">
      <h3 class="te-modal-title">Save Not Available in Web Demo</h3>
      <button class="te-modal-close" autofocus>Got it</button>
    </div>`;
  overlay.querySelector(".te-modal-backdrop").addEventListener("click", () => overlay.remove());
  overlay.querySelector(".te-modal-close").addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
  overlay.querySelector(".te-modal-close").focus();
}

// Brief status toast in the panel meta span.
function _toast(msg, ms = 2500) {
  const el = $("ics-forms-meta");
  if (!el) return;
  const prev = el.textContent;
  el.textContent = msg;
  setTimeout(() => { el.textContent = prev; }, ms);
}

async function openNative(name) {
  // Cloud deployment: serve PDF inline so browser opens it in a new tab.
  // Thumbdrive deployment: same URL also triggers native open server-side.
  window.open(`/ics-forms/open?name=${encodeURIComponent(name)}`, "_blank");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildRow(form) {
  const cur = form.current;
  const li = document.createElement("li");
  li.className = "ics-form-row";
  li.dataset.label = form.label.toLowerCase();
  li.dataset.title = cur.title.toLowerCase();

  li.innerHTML = `
    <span class="ics-form-badge">${escHtml(form.label)}</span>
    <span class="ics-form-title">${escHtml(cur.title)}</span>
    <span class="ics-form-size">${formatBytes(cur.size)}</span>
    <span class="ics-form-date" title="${escHtml(cur.mtime_iso)}">${escHtml(cur.mtime_iso.slice(0,10))}</span>
    <span class="ics-form-actions">
      <button class="btn-ics-open" type="button" title="Open in default PDF app">Open</button>
      <button class="btn-ics-save" type="button" title="Save versioned copy + generate VPO chain block">Save</button>
    </span>
  `;

  li.querySelector(".btn-ics-open").addEventListener("click", () => {
    openNative(cur.name);
  });

  li.querySelector(".btn-ics-save").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) return;
    // Web demo: save-to-session not available — show informational modal
    _showWebDemoModal();
    if (false) try {
      const r = await fetch(`/ics-forms/save?name=${encodeURIComponent(cur.name)}`, { method: "POST" });
      if (!r.ok) { _toast(`Save failed: ${await r.text().catch(() => r.statusText)}`, 4000); return; }
      const data = await r.json().catch(() => ({}));
      const hash = data.vpo_block_hash ? data.vpo_block_hash.slice(0, 12) : null;
      btn.textContent = "Saved ✓";
      if (hash) {
        const vpoLink = document.createElement("a");
        vpoLink.className = "ics-vpo-link";
        vpoLink.textContent = `VPO ⛓ ${hash}…`;
        vpoLink.href = "#";
        vpoLink.title = `VPO block hash: ${data.vpo_block_hash}`;
        vpoLink.addEventListener("click", (ev) => {
          ev.preventDefault();
          document.querySelector('.tab[data-tab="chain"]')?.click();
        });
        li.querySelector(".ics-form-actions").appendChild(vpoLink);
      }
      setTimeout(() => { btn.textContent = "Save"; btn.disabled = false; }, 3000);
      _reloadForms?.();
    } catch (err) {
      _toast(`Save failed: ${err.message}`, 4000);
      btn.textContent = "Save";
      btn.disabled = false;
    }
  });

  if (form.prior_versions?.length) {
    const details = document.createElement("details");
    details.className = "ics-prior-versions";
    const summary = document.createElement("summary");
    summary.textContent = `${form.prior_versions.length} prior version${form.prior_versions.length > 1 ? "s" : ""}`;
    details.appendChild(summary);
    for (const pv of form.prior_versions) {
      const pvEl = document.createElement("div");
      pvEl.className = "ics-prior-version-row";
      pvEl.textContent = `${pv.name} · ${formatBytes(pv.size)} · ${pv.mtime_iso.slice(0,10)}`;
      const pvOpen = document.createElement("button");
      pvOpen.textContent = "Open";
      pvOpen.className = "btn-ics-open-prior";
      pvOpen.type = "button";
      pvOpen.addEventListener("click", () => openNative(pv.name));
      pvEl.appendChild(pvOpen);
      details.appendChild(pvEl);
    }
    li.appendChild(details);
  }

  return li;
}

export async function initFormsPanel() {
  const listEl   = $("ics-forms-list");
  const metaEl   = $("ics-forms-meta");
  const searchEl = $("ics-search");

  let allForms = [];

  async function load() {
    try {
      const r = await fetch("/ics-forms", { cache: "no-store" });
      if (!r.ok) throw new Error(`/ics-forms → ${r.status}`);
      const data = await r.json();
      allForms = data.forms || [];
      if (metaEl) metaEl.textContent = `${allForms.length} forms`;
      render(allForms);
    } catch (e) {
      console.warn("[forms] load failed:", e);
      if (listEl) listEl.innerHTML = `<li class="ics-form-empty">Failed to load ICS forms — is serve.py running?</li>`;
    }
  }

  _reloadForms = load;

  function render(forms) {
    if (!listEl) return;
    listEl.innerHTML = "";
    const ul = document.createElement("ul");
    ul.className = "ics-forms-ul";
    for (const form of forms) ul.appendChild(buildRow(form));
    listEl.appendChild(ul);
  }

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      const q = searchEl.value.trim().toLowerCase();
      if (!q) { render(allForms); return; }
      render(allForms.filter(f =>
        f.label.toLowerCase().includes(q) ||
        f.current.title.toLowerCase().includes(q)
      ));
    });
  }

  // Auto-refresh the list every 8 s so newly-versioned files appear without
  // a manual reload (watcher creates them every ~4 s after a save).
  setInterval(load, 8000);

  await load();
}

export { initFormsPanel as initFormPanel };
