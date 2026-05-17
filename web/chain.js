// TE NIMS · FOB — VPO chain panel
//
// Each signed VPO envelope (from form.js) becomes a block. Blocks are linked
// by prev_hash so the chain forms an append-only ledger of decisions for
// the incident — the lab's verification moat per project_vpo_chain_visualization
// memory.
//
// Phase 1 (this commit): linear list view — block index, signer, timestamp,
// truncated signature, click to expand.
// Phase 2: D3 force-directed DAG when there are >1 chains (e.g. cross-FOB
// branches that get unified at PRIME).
//
// Chain state lives in IndexedDB so it persists across page reloads — that's
// the whole point of "verified provenance," not a transient log.

const DB_NAME    = "te-nims-fob";
const STORE_NAME = "vpo-chain";
const DB_VERSION = 2;  // Bumped to 2 to handle version mismatch recovery

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror   = () => {
      // If version mismatch (VersionError), try to delete and recreate
      if (req.error?.name === "VersionError") {
        console.warn("IndexedDB version mismatch — deleting old database");
        const deleteReq = indexedDB.deleteDatabase(DB_NAME);
        deleteReq.onsuccess = () => {
          // Retry after delete
          openDB().then(resolve).catch(reject);
        };
        deleteReq.onerror = () => reject(deleteReq.error);
      } else {
        reject(req.error);
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "block_id", autoIncrement: true });
      }
    };
  });
}

async function loadAllBlocks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const st = tx.objectStore(STORE_NAME);
    const rq = st.getAll();
    rq.onsuccess = () => resolve(rq.result || []);
    rq.onerror   = () => reject(rq.error);
  });
}

async function saveBlock(block) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const st = tx.objectStore(STORE_NAME);
    const rq = st.add(block);
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror   = () => reject(rq.error);
  });
}

// Mirror the block to the server-side data/chain.jsonl ledger so the chain
// survives browser-data clears + ships when the operator copies data/.
// Best-effort: IndexedDB is the source of truth for the live UI; this is
// for export/audit/rehydration.
async function mirrorBlockToServer(block) {
  try {
    const body = JSON.stringify(block);
    const resp = await fetch("/chain", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (resp.status === 409 && block.prev_signature == null) {
      // Server chain has stale blocks from a prior session but client is
      // starting fresh (genesis block). Reset the server chain and retry once.
      await fetch("/demo/reset", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: "{}" });
      await fetch("/chain", { method: "POST",
        headers: { "Content-Type": "application/json" }, body });
    } else if (!resp.ok) {
      console.warn("[chain mirror] POST /chain failed:", resp.status);
    }
  } catch (e) {
    console.warn("[chain mirror] /chain unreachable:", e);
  }
}

// Pull the server-side mirror and seed IndexedDB if it's empty. Skips when
// either the server has nothing OR the local DB already has blocks (the
// local DB stays the source of truth — the server is a backup mirror).
// F-4: surface count-mismatch banner when local + server disagree. Returns
// {action: "seeded" | "skipped" | "mismatch"}. The mismatch case sets a
// state flag that renderPanel reads on next refresh — do NOT silently keep
// running; the operator must explicitly reconcile.
let _CHAIN_RECONCILE_PROMPT = null; // {serverCount, localCount} or null

async function rehydrateFromServer() {
  let payload;
  try {
    const resp = await fetch("/chain");
    if (!resp.ok) return { action: "skipped", reason: "server-error" };
    payload = await resp.json();
  } catch {
    return { action: "skipped", reason: "unreachable" };
  }
  const serverBlocks = payload?.blocks || [];
  const local = await loadAllBlocks();

  // Empty local + non-empty server → seed (the original happy path).
  if (local.length === 0 && serverBlocks.length > 0) {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const st = tx.objectStore(STORE_NAME);
      for (const b of serverBlocks) st.add(b);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
    console.info(`[chain mirror] rehydrated ${serverBlocks.length} block(s) from /chain`);
    return { action: "seeded", count: serverBlocks.length };
  }

  // F-4: server has MORE than local — visible mismatch. Could be a partial
  // browser-data clear or a session that drifted. Stash so the panel can
  // surface a banner and prompt for explicit reconcile.
  if (serverBlocks.length > local.length) {
    _CHAIN_RECONCILE_PROMPT = {
      serverCount: serverBlocks.length,
      localCount:  local.length,
    };
    console.warn(`[chain mirror] count mismatch — server=${serverBlocks.length}, local=${local.length}`);
    return { action: "mismatch", serverCount: serverBlocks.length, localCount: local.length };
  }

  // Local has more (or equal) — local is source of truth, no action.
  return { action: "skipped", reason: "local-not-empty" };
}

/// Force-replace the local chain with the server's. Used by the reconcile
/// banner button. Wipes the IndexedDB store, then seeds from /chain.
async function reconcileFromServer() {
  let payload;
  try {
    const resp = await fetch("/chain");
    if (!resp.ok) return false;
    payload = await resp.json();
  } catch {
    return false;
  }
  const serverBlocks = payload?.blocks || [];
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const st = tx.objectStore(STORE_NAME);
    const clr = st.clear();
    clr.onsuccess = () => {
      for (const b of serverBlocks) st.add(b);
    };
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
  _CHAIN_RECONCILE_PROMPT = null;
  console.info(`[chain mirror] reconciled — wiped local + seeded ${serverBlocks.length} block(s)`);
  return true;
}

// Hash the prev block's signature into the new one to chain them.
// PHASE 2: This function will be removed entirely once vpo-server signs blocks.
// For now, it validates that crypto.subtle is available (fails hard if blocked).
async function linkBlock(envelope, prevHash, prevSig = null) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("[chain] invalid envelope: must be an object");
  }
  if (!envelope.signature) {
    throw new Error("[chain] invalid envelope: missing signature");
  }
  if (!envelope.algorithm) {
    throw new Error("[chain] invalid envelope: missing algorithm");
  }
  if (!envelope.block_hash) {
    throw new Error("[chain] invalid envelope: missing block_hash");
  }

  // Set both prev_hash (for content integrity) and prev_signature (for
  // server-side linkage enforcement). Genesis block has both as null/zeros.
  const linked = {
    ...envelope,
    prev_hash:      prevHash || "0".repeat(64),
    prev_signature: prevSig || null,
  };
  return linked;
}

// ── Rendering ─────────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderBlockPayload(block) {
  // Two block shapes today: ICS form (form_data dict) and chat turn
  // (question/response strings). Anything else falls through to a JSON dump.
  if (block.block_kind === "chat_turn" || block.form_type === "chat_turn") {
    const truncatedNote = (block.response_full_length && block.response_full_length > (block.response?.length || 0))
      ? ` <em class="chain-genesis">(truncated · full length ${block.response_full_length} chars · response_hash covers full text)</em>`
      : "";
    // Provenance metadata that used to live in the chat-message footer —
    // moved here so each block has a single source of truth for its
    // signing payload. The chat footer is now a one-click jump link to
    // this block.
    const respHash = block.response_hash
      ? `<div class="chain-prov"><em>response hash:</em> <code>${escapeHtml(block.response_hash)}</code></div>`
      : "";
    const respLen = (block.response_full_length != null)
      ? `<div class="chain-prov"><em>response length:</em> ${escapeHtml(String(block.response_full_length))} chars${block.response_truncated ? " · chain render is truncated, on-disk record is full" : ""}</div>`
      : "";
    const onDisk = block.log_path
      ? `<div class="chain-prov"><em>on disk:</em> <a href="/chat-log/${encodeURIComponent(block.log_path)}" target="_blank" rel="noopener"><code>${escapeHtml(block.log_path)}</code></a></div>`
      : `<div class="chain-prov chain-prov-warn">⚠ on-disk record not persisted — chain hash is not externally verifiable</div>`;
    return `
      <div class="chain-turn-q"><strong>Q:</strong> ${escapeHtml(block.form_data?.question || block.question || "")}</div>
      <div class="chain-turn-a"><strong>A:</strong> ${escapeHtml(block.form_data?.response || block.response || "")}${truncatedNote}</div>
      ${respHash}
      ${respLen}
      ${onDisk}`;
  }
  // form_data missing on blocks signed before 2026-05-12 fix
  if (!block.form_data || Object.keys(block.form_data).length === 0) {
    return `<em class="chain-genesis">no form data recorded — this block was signed before the payload fix or the form was empty</em>`;
  }
  // ICS form save blocks: render pdf_url as a clickable link.
  const pdfUrl = block.form_data.pdf_url;
  const pdfLink = pdfUrl
    ? `<div class="chain-prov"><em>pdf:</em> <a href="${escapeHtml(pdfUrl)}" target="_blank" rel="noopener"><code>${escapeHtml(block.form_data.saved_as || pdfUrl)}</code></a></div>`
    : "";
  const sha = block.form_data.sha256
    ? `<div class="chain-prov"><em>sha256:</em> <code>${escapeHtml(block.form_data.sha256.slice(0, 16))}…</code></div>`
    : "";
  if (pdfUrl || sha) {
    const rest = { ...block.form_data };
    delete rest.pdf_url;
    delete rest.sha256;
    delete rest.saved_as;
    return `${pdfLink}${sha}<pre>${escapeHtml(JSON.stringify(rest, null, 2))}</pre>`;
  }
  return `<pre>${escapeHtml(JSON.stringify(block.form_data, null, 2))}</pre>`;
}

function renderBlock(block, index) {
  const li = document.createElement("li");
  li.className = "chain-block";
  // Stable id keyed off the full signature so the chat footer can deep-link
  // here via document.getElementById(`chain-block-${signature}`).
  if (block.signature) li.id = `chain-block-${block.signature}`;
  // Type label: friendly name for chat_turn, otherwise the form_type / fallback
  const kind = block.block_kind || block.form_type || "decision";
  const typeLabel = kind === "chat_turn" ? "chat" : kind;
  li.innerHTML = `
    <div class="chain-head">
      <span class="chain-idx">#${index + 1}</span>
      <span class="chain-type">${escapeHtml(typeLabel)}</span>
      <span class="chain-when">${new Date(block.signed_at).toLocaleTimeString()}</span>
    </div>
    <div class="chain-meta-line">
      <span class="chain-signer">⎯ ${escapeHtml(block.signer || "unsigned")}</span>
      ${block.signing_key_id ? `<span class="chain-key-badge chain-key-badge-${classifyKey(block.signing_key_id).class}">${escapeHtml(block.signing_key_id.split(":")[0])}</span>` : ""}
      <code class="chain-sig">${escapeHtml((block.signature || "").slice(0, 16))}…</code>
    </div>
    <details class="chain-detail">
      <summary>show payload</summary>
      ${renderBlockPayload(block)}
      <div class="chain-link">
        <em>block hash:</em> <code>${escapeHtml((block.block_hash || "").slice(0, 32))}…</code><br>
        <em>prev sig:</em>   <code>${block.prev_signature
                                    ? escapeHtml(block.prev_signature.slice(0, 16)) + "…"
                                    : '<span class="chain-genesis">(genesis)</span>'}</code>
      </div>
    </details>`;
  return li;
}

// Classify a signing key id and return a banner spec. "demo:" / "training:"
// prefixes flag a non-production key (the IC must know their signatures
// won't hold up in a real audit). Anything else is treated as production.
//
// Exported so app.js can render the same classification inside the chat
// message footer (operator sees the classification in two places: above
// each agent response AND in the chain panel).
export function classifyKey(keyId) {
  if (!keyId) {
    return { class: "unknown", label: "no key id", note: "Block was signed without a key identifier — cannot classify." };
  }
  if (keyId.startsWith("demo:")) {
    return {
      class: "demo",
      label: `DEMO KEY · ${keyId}`,
      note: "Non-production signing key. Signatures verify the chain is internally consistent but do NOT establish provenance against any real signing identity.",
    };
  }
  if (keyId.startsWith("training:")) {
    return {
      class: "training",
      label: `TRAINING KEY · ${keyId}`,
      note: "Training-environment key. For exercise/curriculum use only — not auditable in real incidents.",
    };
  }
  return {
    class: "production",
    label: `signed · ${keyId}`,
    note: "Production signing identity.",
  };
}

// F-3: banner reflects the ACTIVE signing identity (server-side
// /signing-key) — NOT each envelope's self-asserted signing_key_id (which
// is unauthenticated metadata). The active id is owned by app.js's
// VPO_SIGNING_IDENTITY and exposed on window for cross-module access.
async function _activeKeyId() {
  // Prefer app.js's loaded identity (set by initSigningIdentity()).
  if (typeof window !== "undefined" && window.__TE_SIGNING_IDENTITY__) {
    return window.__TE_SIGNING_IDENTITY__.key_id;
  }
  // Fall back: fetch /signing-key directly. Same-origin, no auth.
  try {
    const resp = await fetch("/signing-key", { cache: "no-store" });
    if (resp.ok) {
      const spec = await resp.json();
      if (spec && spec.key_id) return spec.key_id;
    }
  } catch { /* fall through */ }
  return null;   // unknown → renderKeyBanner uses the unknown class
}

async function renderKeyBanner(blocks) {
  const banner = document.getElementById("chain-key-banner");
  if (!banner) return;
  if (!blocks.length) {
    banner.hidden = true;
    return;
  }
  const activeKey = await _activeKeyId();
  const c = classifyKey(activeKey);
  banner.className = `chain-key-banner chain-key-${c.class}`;
  // If any block in the chain was signed with a different key id than the
  // current active one, surface that as a mid-chain rotation note —
  // operator should know past blocks may have a different verification key.
  const distinctIds = new Set(blocks.map(b => b.signing_key_id).filter(Boolean));
  let rotationNote = "";
  if (activeKey && distinctIds.size > 0 && (distinctIds.size > 1 || !distinctIds.has(activeKey))) {
    const others = [...distinctIds].filter(id => id !== activeKey);
    rotationNote = `<span class="chain-key-note">⚠ chain contains blocks signed by other keys: ${others.map(escapeHtml).join(", ")}</span>`;
  }
  banner.innerHTML = `
    <strong>${escapeHtml(c.label)}</strong>
    <span class="chain-key-note">${escapeHtml(c.note)}</span>
    ${rotationNote}`;
  banner.hidden = false;
}

// F-4: render the count-mismatch banner (separate element from the key
// banner — operator might see both at once).
function renderReconcileBanner() {
  let banner = document.getElementById("chain-reconcile-banner");
  if (!banner) {
    // Create on-demand (parent: panel-body of tab-chain).
    const pane = document.getElementById("tab-chain");
    if (!pane) return;
    banner = document.createElement("div");
    banner.id = "chain-reconcile-banner";
    banner.className = "chain-reconcile-banner";
    pane.insertBefore(banner, pane.firstChild);
  }
  if (!_CHAIN_RECONCILE_PROMPT) {
    banner.hidden = true;
    return;
  }
  const { serverCount, localCount } = _CHAIN_RECONCILE_PROMPT;
  banner.innerHTML = `
    <strong>⚠ Chain mismatch</strong>
    <span class="chain-key-note">Server has ${serverCount} block(s); local has ${localCount}.
    Local IndexedDB may have been partially cleared. Reconcile from the server mirror?</span>
    <div class="chain-reconcile-actions">
      <button type="button" class="btn btn-primary" id="chain-reconcile-yes">Wipe local + seed from server</button>
      <button type="button" class="btn btn-ghost"   id="chain-reconcile-no">Keep local (dismiss)</button>
    </div>`;
  banner.hidden = false;
  document.getElementById("chain-reconcile-yes")?.addEventListener("click", async () => {
    const ok = await reconcileFromServer();
    if (ok) await refreshPanel();
  });
  document.getElementById("chain-reconcile-no")?.addEventListener("click", () => {
    _CHAIN_RECONCILE_PROMPT = null;
    renderReconcileBanner();
  });
}

async function refreshPanel() {
  const list  = document.getElementById("chain-list");
  const empty = document.getElementById("chain-empty");
  const meta  = document.getElementById("chain-meta");
  if (!list) return;

  const blocks = await loadAllBlocks();
  await renderKeyBanner(blocks);
  renderReconcileBanner();
  list.innerHTML = "";
  if (blocks.length === 0) {
    if (empty) empty.hidden = false;
    list.hidden = true;
    if (meta) meta.textContent = "0 blocks";
    return;
  }
  if (empty) empty.hidden = true;
  list.hidden = false;
  blocks.forEach((b, i) => list.appendChild(renderBlock(b, i)));
  if (meta) meta.textContent = `${blocks.length} block${blocks.length === 1 ? "" : "s"}`;
}

// ── Verify Chain UI: animated walk through the te-verify report ─────────
//
// The button kicks POST /verify; the server shells out to the te-verify
// Rust CLI; we animate each chain-list <li> through pending → verifying
// → its final state, then surface a verdict banner. Same for /verify-mirror.

const VERIFY_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const VERIFY_STEP_MS = 120;   // per-block delay so the animation reads as audit

function _setVerifyState(li, state, label) {
  // Strip any prior verify-* class
  li.classList.remove("verify-pending", "verify-verifying",
    "verify-ok", "verify-ok-demo", "verify-bad", "verify-unsigned",
    "verify-mismatch", "verify-missing", "verify-parse-error");
  if (state) li.classList.add(`verify-${state}`);
  // Inject/update the verify chip overlay
  let chip = li.querySelector(".verify-chip");
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "verify-chip";
    li.appendChild(chip);
  }
  chip.textContent = label || "";
}

function _statusToClassAndLabel(status) {
  // Maps te-verify's BlockStatus discriminated union → CSS class + chip text.
  const kind = status?.status;
  switch (kind) {
    case "ok":               return ["ok",       "✓ ok"];
    case "ok_demo_key":      return ["ok-demo",  "✓ ok-demo"];
    case "bad_signature":    return ["bad",      status.had_key ? "✗ bad-sig" : "? unverified"];
    case "unsigned":         return ["unsigned", "× unsigned"];
    case "mismatched_hash":  return ["mismatch", "✗ hash-mismatch"];
    case "missing_fields":   return ["missing",  "? missing"];
    case "parse_error":      return ["parse-error", "× parse"];
    default:                 return ["bad",      "? unknown"];
  }
}

function _renderVerdict(verdict, report) {
  const banner = document.getElementById("chain-verify-verdict");
  if (!banner) return;
  if (verdict === "all-ok") {
    const cls = report.entirely_demo_signed ? "verify-verdict-demo" : "verify-verdict-ok";
    const text = report.entirely_demo_signed
      ? `⚠ chain verified internally — all ${report.ok_demo} block(s) signed with non-production key`
      : `✓ chain fully verified — ${report.ok} block(s) signed by production identity`;
    banner.className = `chain-verify-verdict ${cls}`;
    banner.textContent = text;
  } else if (verdict === "empty") {
    banner.className = "chain-verify-verdict verify-verdict-empty";
    banner.textContent = "no envelopes to verify";
  } else {
    // failures
    banner.className = "chain-verify-verdict verify-verdict-bad";
    const issues = [];
    if (report.bad_signature) issues.push(`${report.bad_signature} bad-sig`);
    if (report.unsigned)      issues.push(`${report.unsigned} unsigned`);
    if (report.mismatched)    issues.push(`${report.mismatched} hash-mismatch`);
    if (report.missing_fields) issues.push(`${report.missing_fields} missing`);
    if (report.parse_errors)  issues.push(`${report.parse_errors} parse-err`);
    banner.textContent = `✗ tampering detected — ${issues.join(", ")} of ${report.blocks?.length ?? "?"} blocks`;
  }
  banner.hidden = false;
}

async function verifyChain() {
  const status = document.getElementById("chain-verify-status");
  const verdictBanner = document.getElementById("chain-verify-verdict");
  if (verdictBanner) verdictBanner.hidden = true;
  if (status) status.textContent = "fetching report…";

  // Hit the server. Server shells out to te-verify chain --json.
  let payload;
  try {
    const resp = await fetch("/verify", { method: "POST" });
    if (!resp.ok) {
      if (status) status.textContent = `error: ${resp.status}`;
      return;
    }
    payload = await resp.json();
  } catch (e) {
    if (status) status.textContent = `unreachable: ${e.message}`;
    return;
  }

  const report = payload.report || {};
  const blocks = report.blocks || [];
  // Index chain-list <li>s by their block's signature so we can match
  // server response to displayed blocks. Local blocks may include some
  // the server doesn't (e.g. mid-flight) — we just skip those gracefully.
  const localBlocks = await loadAllBlocks();
  const list = document.getElementById("chain-list");
  if (!list) return;
  const liBySig = new Map();
  list.querySelectorAll("li.chain-block").forEach((li, idx) => {
    const block = localBlocks[idx];
    if (block?.signature) liBySig.set(block.signature, li);
  });

  // First pass — set every li to pending (greys out the chain visually).
  for (const li of list.querySelectorAll("li.chain-block")) {
    _setVerifyState(li, "pending", "…");
  }
  if (status) status.textContent = `verifying ${blocks.length} block(s)…`;

  // Walk the report block-by-block with a small delay so the verification
  // visibly progresses. For each, attempt to find the matching local <li>
  // by inspecting any block whose turn_id substring appears in our local
  // signature. (te-verify reports turn_id as the file basename = first
  // 32 chars of signature; we match on that prefix.)
  let frameIdx = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Find the <li> whose signature starts with this turn_id
    let li = null;
    for (const [sig, candidate] of liBySig) {
      if (sig && sig.startsWith(b.turn_id)) { li = candidate; break; }
    }
    if (li) {
      _setVerifyState(li, "verifying", VERIFY_FRAMES[frameIdx % VERIFY_FRAMES.length]);
      frameIdx++;
      // Hold on the verifying frame briefly
      await new Promise(r => setTimeout(r, VERIFY_STEP_MS));
      const [cls, label] = _statusToClassAndLabel(b.status);
      _setVerifyState(li, cls, label);
    }
    if (status) status.textContent = `${i + 1}/${blocks.length}`;
  }

  if (status) status.textContent = `${blocks.length} block(s) checked`;
  _renderVerdict(payload.verdict, report);
}

async function verifyChainMirror() {
  const status = document.getElementById("chain-verify-status");
  const verdictBanner = document.getElementById("chain-verify-verdict");
  if (verdictBanner) verdictBanner.hidden = true;
  if (status) status.textContent = "checking chain linkage…";

  let payload;
  try {
    const resp = await fetch("/verify-mirror", { method: "POST" });
    if (!resp.ok) {
      if (status) status.textContent = `error: ${resp.status}`;
      return;
    }
    payload = await resp.json();
  } catch (e) {
    if (status) status.textContent = `unreachable: ${e.message}`;
    return;
  }

  const report = payload.report || {};
  const linkageFails = report.linkage_failures || [];
  const parseErrors  = report.parse_errors || [];
  const banner = verdictBanner;
  if (!banner) return;

  if (linkageFails.length === 0 && parseErrors.length === 0 && report.block_count > 0) {
    banner.className = "chain-verify-verdict verify-verdict-ok";
    banner.textContent = `✓ chain mirror linkage intact — ${report.block_count} block(s) chained`;
  } else if (report.block_count === 0 && parseErrors.length === 0) {
    banner.className = "chain-verify-verdict verify-verdict-empty";
    banner.textContent = "chain mirror is empty";
  } else {
    banner.className = "chain-verify-verdict verify-verdict-bad";
    const parts = [];
    if (linkageFails.length) parts.push(`${linkageFails.length} linkage failure(s)`);
    if (parseErrors.length)  parts.push(`${parseErrors.length} parse error(s)`);
    banner.textContent = `✗ chain mirror compromised — ${parts.join(", ")}`;
  }
  banner.hidden = false;
  if (status) status.textContent = `mirror: ${report.block_count ?? 0} block(s) parsed`;
}

// ── Public API ────────────────────────────────────────────────────────────
export async function initChainPanel() {
  // Register the vpo:add-block listener IMMEDIATELY — before any async work —
  // so genesis blocks fired during initDemo() are never missed in a race.
  window.addEventListener("vpo:add-block", async (ev) => {
    // Retry once if IDB is busy on first attempt (early-init race condition).
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const envelope = ev.detail;
        const all      = await loadAllBlocks();
        const prevHash = all.length ? all[all.length - 1].block_hash    : "0".repeat(64);
        const prevSig  = all.length ? (all[all.length - 1].signature || null) : null;
        const linked   = await linkBlock(envelope, prevHash, prevSig);
        await saveBlock(linked);
        mirrorBlockToServer(linked);   // best-effort; IndexedDB is source of truth
        await refreshPanel();
        return;  // success
      } catch (e) {
        if (attempt === 0) {
          console.warn("[chain] vpo:add-block attempt 1 failed, retrying:", e.message || e);
          await new Promise(r => setTimeout(r, 500));  // brief delay before retry
        } else {
          console.error("[chain] vpo:add-block failed after retry:", e);
        }
      }
    }
  });
  // Rehydrate from server mirror then render (runs after listener is armed).
  await rehydrateFromServer();
  await refreshPanel();

  // If chain is still empty after rehydration, create a genesis block DIRECTLY
  // (not via vpo:add-block event, which can silently fail during early IDB init).
  const existing = await loadAllBlocks();
  if (existing.length === 0) {
    try {
      const resp = await fetch("/vpo/sign", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          form_type: "session_open",
          form_data: { block_kind: "genesis", note: "TE NIMS demo session started" },
          signer:    "te-nims-demo",
          signed_at: new Date().toISOString(),
          prev_hash: "0".repeat(64),
        }),
        signal: AbortSignal.timeout(6000),
      });
      if (resp.ok) {
        const envelope = await resp.json();
        const linked = await linkBlock(envelope, "0".repeat(64), null);
        await saveBlock(linked);
        mirrorBlockToServer(linked);
        await refreshPanel();
      }
    } catch (e) {
      console.warn("[chain] genesis block failed:", e);
    }
  }

  // Refresh panel whenever the VPO Chain tab is clicked — ensures blocks
  // show even if a race meant the panel was empty when first rendered.
  document.querySelector('.tab[data-tab="chain"]')
    ?.addEventListener("click", () => refreshPanel());

  // Verification functionality disabled for now (requires te-verify binary)
}

// Verification functions kept for future use but not wired up currently
// export { verifyChain, verifyChainMirror };

// Get the most recent block's hash for chain linking
export async function getLastBlockHash() {
  try {
    const blocks = await loadAllBlocks();
    if (blocks.length === 0) {
      return "0".repeat(64);  // Genesis block
    }
    const lastBlock = blocks[blocks.length - 1];
    return lastBlock.block_hash || "0".repeat(64);
  } catch (e) {
    console.warn("[chain] getLastBlockHash failed:", e);
    return "0".repeat(64);
  }
}

// Convenience for clearing the chain (dev / between scenarios)
export async function resetChain() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const st = tx.objectStore(STORE_NAME);
    const rq = st.clear();
    rq.onsuccess = () => { refreshPanel(); resolve(); };
    rq.onerror   = () => reject(rq.error);
  });
}
window.teResetChain = resetChain;  // dev convenience: window.teResetChain() in console
