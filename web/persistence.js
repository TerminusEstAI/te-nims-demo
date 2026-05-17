// TE NIMS · FOB — persistence helpers
//
// Two stores:
//   - IndexedDB (te-nims-fob.session)  — chat conversation array + form
//     drafts. Structured + potentially large; IDB is the right tool.
//   - localStorage (te-fob-* keys)     — map state + TTS toggle + indexed
//     document handles. Tiny, cheap, synchronous.
//
// All functions degrade gracefully on storage errors (private mode, quota,
// etc.) — failures log but never throw to the caller. The app must keep
// working even when persistence breaks.

const DB_NAME = "te-nims-fob";
const DB_VERSION = 2;                    // bumped from chain.js v1 to add session store
const STORE_CHAIN   = "vpo-chain";       // existing (chain.js)
const STORE_SESSION = "session";         // new — { key: "conversation"|"form-draft"|..., value: any }

// ── Shared IDB connection ────────────────────────────────────────────────
let _db = null;
function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror   = () => reject(req.error);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE_CHAIN)) {
        db.createObjectStore(STORE_CHAIN, { keyPath: "block_id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION, { keyPath: "key" });
      }
    };
  });
}

async function idbGet(key) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSION, "readonly");
      const st = tx.objectStore(STORE_SESSION);
      const rq = st.get(key);
      rq.onsuccess = () => resolve(rq.result?.value ?? null);
      rq.onerror   = () => reject(rq.error);
    });
  } catch (e) {
    console.warn(`[persist] idbGet(${key}) failed:`, e);
    return null;
  }
}

async function idbSet(key, value) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSION, "readwrite");
      const st = tx.objectStore(STORE_SESSION);
      const rq = st.put({ key, value });
      rq.onsuccess = resolve;
      rq.onerror   = () => reject(rq.error);
    });
  } catch (e) {
    console.warn(`[persist] idbSet(${key}) failed:`, e);
  }
}

async function idbDelete(key) {
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SESSION, "readwrite");
      const st = tx.objectStore(STORE_SESSION);
      const rq = st.delete(key);
      rq.onsuccess = resolve;
      rq.onerror   = () => reject(rq.error);
    });
  } catch (e) {
    console.warn(`[persist] idbDelete(${key}) failed:`, e);
  }
}

// ── Chat conversation ────────────────────────────────────────────────────
//
// Persists the full conversation[] array (system prompt + every turn) plus
// a parallel array of "renders" — what was actually painted in the chat
// panel for each turn (text + attached image dataUrls + document tiles).
// On boot, app.js reads both: the conversation goes into the LLM context;
// the renders re-paint the chat panel so the operator picks up exactly
// where they left off.

const KEY_CONV = "conversation";
const CONV_MAX_TURNS = 200;     // safety cap — chat history beyond this trims oldest first

export async function saveConversation(conversation, renders) {
  // Cap to avoid unbounded growth; trim from the FRONT but keep the system
  // prompt at index 0.
  const trimmedConv = conversation.length > CONV_MAX_TURNS
    ? [conversation[0], ...conversation.slice(-(CONV_MAX_TURNS - 1))]
    : conversation;
  const trimmedRen = renders.slice(-CONV_MAX_TURNS);
  await idbSet(KEY_CONV, {
    saved_at: Date.now(),
    conversation: trimmedConv,
    renders:      trimmedRen,
  });
}

export async function loadConversation() {
  return await idbGet(KEY_CONV);
}

export async function clearConversation() {
  await idbDelete(KEY_CONV);
}

// ── ICS-201 form draft ───────────────────────────────────────────────────
const KEY_FORM = "form-draft-ics-201";

export async function saveFormDraft(fields) {
  await idbSet(KEY_FORM, { saved_at: Date.now(), fields });
}

export async function loadFormDraft() {
  const v = await idbGet(KEY_FORM);
  return v?.fields ?? null;
}

export async function clearFormDraft() {
  await idbDelete(KEY_FORM);
}

// ── Map state (zoom/center + last locate) ─ localStorage ─────────────────
const LS_MAP   = "te-fob-map-state";
const LS_TTS   = "te-fob-tts-enabled";
const LS_DOCS  = "te-fob-doc-index";

function lsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.warn(`[persist] lsGet(${key}) failed:`, e);
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn(`[persist] lsSet(${key}) failed:`, e);
  }
}

export function saveMapState(state)  { lsSet(LS_MAP, state); }
export function loadMapState()       { return lsGet(LS_MAP); }
export function saveTtsEnabled(on)   { lsSet(LS_TTS, !!on); }
export function loadTtsEnabled()     { return lsGet(LS_TTS, false); }

// ── Indexed document handles ─ localStorage ──────────────────────────────
//
// The server caches embeddings under data/document-cache/<doc_id>.json.
// The CLIENT remembers which docs it has prepared so they show as
// "ready" in the document panel without re-running /document/prepare.
// Each entry: { name, title, doc_id, chunks, prepared_at }.

export function loadDocIndex()       { return lsGet(LS_DOCS, []); }

export function saveDocEntry(entry) {
  const list = loadDocIndex();
  const idx = list.findIndex((d) => d.doc_id === entry.doc_id);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry };
  else list.push(entry);
  lsSet(LS_DOCS, list);
}

export function clearDocIndex()      { lsSet(LS_DOCS, []); }
