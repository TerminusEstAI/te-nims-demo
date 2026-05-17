// TE NIMS · FOB — WebLLM POC
//
// Runs an LLM fully in the browser via WebGPU. No server, no install.
// Multi-pane COP layout: chat / map / ICS form / VPO chain (3 panels stubbed).

import { marked }              from "https://cdn.jsdelivr.net/npm/marked@9/+esm";
import { activeScenario, LOCATIONS } from "./config.js";
import { initMap, addPin, getMap, zoomTo,
         loadDamageOverlay,    toggleDamageOverlay,
         loadTrackOverlay,     toggleTrackOverlay,
         loadBuildingsOverlay, toggleBuildingsOverlay,
         toggleTileLayer } from "./map.js";
import { initFormsPanel }      from "./form.js";
import { initChainPanel, classifyKey, getLastBlockHash } from "./chain.js";
import { initVoice, speak, stopSpeaking } from "./voice.js";
import { openArtifactUrl, refreshArtifacts, addUploadArtifact } from "./artifacts.js";
import * as persist                     from "./persistence.js";
import { startTour, advanceTour, isTourActive, resetTour } from "./tour.js";
import { initUploadPanel } from "./upload.js";
// Leaflet (global L) is loaded via <script> in index.html before this module.

// Inline configuration. Tighten as needed.
marked.setOptions({
  gfm: true,
  breaks: true,
  // No HTML in model output for safety; marked sanitizes by escaping unknown tags.
  mangle: false,
  headerIds: false,
});

// ── Severian backend (Ollama on localhost) ─────────────────────────
// Per STRATEGY.md, the FOB web UI talks to a local Ollama serving the
// Stage 5 GGUF — typically the lab's CLI thumbdrive bundle, extended
// with the static web UI. Real Severian responses, fully offline, no
// MLC compile needed (MLC doesn't support Gemma 4 yet).
//
// Probe ladder mirrors chat.py: thumbdrive Ollama on :11500 first,
// system Ollama on :11434 second. The model must exactly match
// OLLAMA_MODEL — no fallback to a different one.
const OLLAMA_MODEL = "severian-ollama";

// Probe ladder:
//   1. ?ollama=<url> URL param (dev override; e.g. point at Studio over Tailscale)
//   2. /api/ollama (same-origin serve.py proxy — no CORS, works when serve.py is up)
//   3. localhost:11500 (FOB thumbdrive launcher convention — see te.command)
//   4. localhost:11434 (system Ollama default)
function ollamaCandidates() {
  const params = new URLSearchParams(window.location.search);
  const override = params.get("ollama");
  const list = [
    `${window.location.origin}/api/ollama`,
    "http://localhost:11500",
    "http://localhost:11434",
  ];
  return override ? [override.replace(/\/+$/, ""), ...list] : list;
}

// Vision endpoint — separate llama-server process hosting severian-vision
// + mmproj. OpenAI-compatible API at /v1/chat/completions. Used only for
// turns that include image attachments (text-only stays on Ollama). Set
// via ?vision=<url> URL param at launch time. Returns null when not
// configured — image queries then surface a clear error instead of
// silently degrading.
function visionEndpoint() {
  const params = new URLSearchParams(window.location.search);
  const v = params.get("vision");
  if (v) return v.replace(/\/+$/, "");
  // Default: standalone llama-server sidecar at /vision/* (Caddy-proxied).
  // Ollama's bundled llama.cpp lacks gemma4 multimodal — text path only.
  // Override via ?vision=<url> for local dev (e.g. http://localhost:8081).
  return window.location.origin + "/vision";
}

// Canonical ICS forms — built into the system prompt so the model has
// authoritative reference data and doesn't have to refuse "list the
// ICS forms" queries. Source: FEMA NIMS ICS Forms Booklet (FEMA P-501).
const ICS_FORMS_REFERENCE = `
ICS-201  Incident Briefing
ICS-202  Incident Objectives
ICS-203  Organization Assignment List
ICS-204  Assignment List
ICS-205  Incident Radio Communications Plan
ICS-205A Communications List
ICS-206  Medical Plan
ICS-207  Incident Organizational Chart
ICS-208  Safety Message / Plan
ICS-209  Incident Status Summary
ICS-210  Resource Status Change
ICS-211  Incident Check-In List
ICS-213  General Message
ICS-214  Activity Log
ICS-215  Operational Planning Worksheet
ICS-215A Incident Action Plan Safety Analysis
ICS-218  Support Vehicle / Equipment Inventory
ICS-219  Resource Status Cards (T-Cards)
ICS-220  Air Operations Summary
ICS-221  Demobilization Check-Out
ICS-225  Incident Personnel Performance Rating`;

const SYSTEM_PROMPT = `You are TE NIMS — a verified decision-support agent for incident commanders.
Ground every answer in NIMS / ICS doctrine. Speak briefly and tactically:
a 2-3 sentence summary first, then optional doctrine citation.

You DO know the canonical ICS form set; reference list:
${ICS_FORMS_REFERENCE}

When asked to "list the ICS forms" or similar, list them from the
reference above. Do not refuse on the grounds of "constantly changing" —
this is the authoritative FEMA-published set (P-501). If a specific
form a user asks about is NOT in this list, then say so.

Never invent FEMA Stafford Act section numbers you don't know — for
those, flag the uncertainty and recommend consulting the live doctrine
library.

Never issue field orders directly — propose options for the IC's approval.
Audience: an Incident Commander in the field. Prioritize the actionable
summary. Use **bold labels** for "Action:", "Recommendation:", "Note:",
"Crucial Advisory:" etc. so the IC can scan quickly.

Geography conventions (treat as canonical):
- "OK"  = Oklahoma (US state)
- "OKC" = Oklahoma City (the state capital, current operational area)
Never read "OK" as the colloquial "okay" in this domain.

## Tool Use
When you need real incident data you don't already have, emit exactly one tool call and then STOP — do not invent results:

<tool_call>{"name": "TOOL_NAME", "args": {"key": "value"}}</tool_call>

A <tool_result> containing the actual data will follow. Use it to answer.
Only call a tool when the answer genuinely requires live incident data.
For general doctrine or ICS procedure questions, answer directly from training.

Available tools:
  search_doctrine(query: string)              — retrieve NIMS/ICS doctrine passages from the library
  get_damage_summary()                        — building damage counts by severity for this incident
  get_scenario_info()                         — incident name, timeline, and key site coordinates
  list_resources()                            — staged emergency resources at the ICP
  find_closest(type, lat?, lon?)              — nearest location of a given type (hospital | shelter | staging | eoc | incident)`;

const $ = (id) => document.getElementById(id);
const statusDot   = $("status-dot");
const statusText  = $("status-text");
const chatMeta    = $("chat-meta");
const chatArea    = $("chat-area");
const promptInput = $("prompt");
const sendButton  = $("send");
const composer    = $("composer");
const footerStat  = $("footer-status");

const conversation = [{ role: "system", content: SYSTEM_PROMPT }];
// Per-turn render record (parallel to conversation, but only for messages
// that need to repaint on reload — user turns + assistant turns; we skip
// the system prompt and any retrieved-context system messages since the
// chat panel doesn't show those). Each entry:
//   { role: "user",      text, images, documents }
//   { role: "assistant", text, signature?, signing_key_id?, signed_at? }
const renders = [];

async function persistChat() {
  try { await persist.saveConversation(conversation, renders); }
  catch (e) { console.warn("[persist chat] failed:", e); }
}

function setStatus(state, text) {
  statusDot.classList.remove("up", "down");
  if (state === "up")    statusDot.classList.add("up");
  if (state === "down")  statusDot.classList.add("down");
  statusText.textContent = text;
}

// Restore-from-persistence variant: same DOM render as appendUserMsg but
// uses persisted dataUrls / docs without re-running attachments. Used by
// boot-time conversation restore.
function paintUserMsg(record) {
  return appendUserMsg(record.text || "", record.images || [], record.documents || []);
}

function appendUserMsg(text, images = [], documents = []) {
  const el = document.createElement("div");
  el.className = "msg user";
  if (documents.length) {
    // Document attachments — show 📄 + title + clickable URL above any
    // images and the text. Same provenance pattern as artifact drops.
    const docWrap = document.createElement("div");
    docWrap.className = "msg-user-docs";
    for (const d of documents) {
      const tile = document.createElement("div");
      tile.className = "msg-user-doc-tile";
      tile.innerHTML = `
        <span class="msg-user-doc-icon">📄</span>
        <a href="${d.url}" target="_blank" rel="noopener" class="msg-user-doc-link">${d.title}</a>
        <span class="msg-user-doc-status">${d.status === "ready" ? `(${d.chunks} chunks)` : d.status}</span>`;
      docWrap.appendChild(tile);
    }
    el.appendChild(docWrap);
  }
  if (images.length) {
    // Render attached images above the text. Each image is clickable into
    // the same modal lightbox the artifacts tab uses (wireInlineArtifactImages
    // is called below to attach the click handler). Artifacts dragged from
    // the panel also show a clickable URL line so the chat history records
    // provenance — exactly what the operator asked for.
    const imgWrap = document.createElement("div");
    imgWrap.className = "msg-user-images";
    for (const img of images) {
      const tile = document.createElement("div");
      tile.className = "msg-user-image-tile";
      const i = document.createElement("img");
      i.src = img.dataUrl;
      i.alt = img.name || "attached image";
      tile.appendChild(i);
      if (img.sourceUrl) {
        const a = document.createElement("a");
        a.href = img.sourceUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "msg-user-image-url";
        // Strip origin for display so the line stays compact.
        a.textContent = img.sourceUrl.replace(/^https?:\/\/[^/]+/, "");
        tile.appendChild(a);
      }
      imgWrap.appendChild(tile);
    }
    el.appendChild(imgWrap);
    wireInlineArtifactImages(imgWrap);
  }
  if (text) {
    const t = document.createElement("div");
    t.className = "msg-user-text";
    t.textContent = text;
    el.appendChild(t);
  }
  chatArea.appendChild(el);
  chatArea.scrollTop = chatArea.scrollHeight;
  return el;
}

function appendSystemMsg(html) {
  const el = document.createElement("div");
  el.className = "msg system";
  el.innerHTML = html;
  chatArea.appendChild(el);
  chatArea.scrollTop = chatArea.scrollHeight;
  return el;
}

// Wrap leading sentence-start labels ("Crucial Advisory:" / "Note:" / "Recommendation:")
// in **bold** so they get the orange treatment from CSS strong styling. The model
// usually emits them as **Bold:** but sometimes drops the markdown — this catches
// the plain form too. Conservative: only multi-word labels at start of line.
const LABEL_RE = /^(\s*)([A-Z][a-z]+(?:\s+[A-Za-z]+){0,3}):/gm;
function emphasizeLabels(md) {
  return md.replace(LABEL_RE, (m, lead, label) => {
    // Skip if already wrapped in ** or already emphasized
    if (m.includes("**")) return m;
    return `${lead}**${label}:**`;
  });
}

// Braille spinner frames — same set the CLI uses (chat.py _Spinner._FRAMES)
const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const SPINNER_VERBS  = ["Thinking", "Consulting doctrine", "Analyzing", "Processing"];

// Strip model-emitted tool calls from response text.
// Pattern: response:tool.name{value:<|"|>content<|"|>}
// Returns { toolCalls: [{name, value}], answer }
function parseModelToolCalls(text) {
  const toolCalls = [];
  const re = /response:([\w.]+)\{value:<\|"\|>([\s\S]*?)<\|"\|>\}/g;
  let match;
  const hits = [];
  while ((match = re.exec(text)) !== null) {
    hits.push({ full: match[0], name: match[1], value: match[2], index: match.index });
  }
  // Strip all tool-call blocks from right-to-left (preserve remaining indices)
  let answer = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    answer = answer.slice(0, h.index) + answer.slice(h.index + h.full.length);
    toolCalls.unshift({ name: h.name, value: h.value });
  }
  // Strip any lingering <tool_response|> delimiter the model emits
  answer = answer.replace(/<tool_response\|>/g, "").trim();
  return { toolCalls, answer, hasToolCalls: toolCalls.length > 0 };
}

// Extract reasoning trace and answer from model output.
// Format: "Thinking Process:\n1. ...\n2. ...\nFinal Output Generation.\n...<answer>"
// Returns { reasoning, answer, hasReasoning }
function parseReasoningAndAnswer(fullText) {
  // Check if reasoning trace exists (marked by "Thinking Process:" header)
  if (!fullText.includes("Thinking Process:")) {
    // No reasoning trace found, entire text is the answer
    return { reasoning: "", answer: fullText, hasReasoning: false };
  }

  // Find where the reasoning ends — look for transition to final answer section
  // Reasoning ends when we see: "Final Output Generation", or a labeled section like
  // "Recommendation:", "Crucial Advisory:", "Action:", "Note:" at start of line
  const answerStartPatterns = [
    /\n(Final Output Generation|Recommendation|Crucial Advisory|Action|Note):/i,
  ];

  let answerStartIdx = -1;
  for (const pattern of answerStartPatterns) {
    const match = fullText.match(pattern);
    if (match) {
      answerStartIdx = match.index;
      break;
    }
  }

  if (answerStartIdx === -1) {
    // Reasoning present but no clear answer section found
    // Assume everything is reasoning if it's all "Thinking Process" section
    if (fullText.includes("Final Output Generation")) {
      answerStartIdx = fullText.indexOf("Final Output Generation");
    } else {
      // Return full text as reasoning if no answer found
      return {
        reasoning: fullText,
        answer: "",
        hasReasoning: true
      };
    }
  }

  const reasoning = fullText.slice(0, answerStartIdx).trim();
  const answer = fullText.slice(answerStartIdx).trim();

  return { reasoning, answer, hasReasoning: true };
}

// Streaming assistant message — accumulates raw markdown, re-renders on every token.
// Shows a thinking-spinner that matches the CLI demo until the first real token
// arrives, then automatically swaps to the rendered markdown.
function appendStreamingAssistant() {
  const wrapper = document.createElement("div");
  wrapper.className = "msg assistant";

  const label = document.createElement("span");
  label.className = "label";
  // T orange / E white / NIMS orange branding (same as CLI)
  label.innerHTML = '<span class="t">T</span><span class="e">E</span><span class="rest"> NIMS</span>:';
  wrapper.appendChild(label);

  const body = document.createElement("div");
  body.className = "body";
  wrapper.appendChild(body);

  chatArea.appendChild(wrapper);
  chatArea.scrollTop = chatArea.scrollHeight;

  let raw = "";
  let firstToken = true;
  let fullTextBuffer = "";
  let frame = 0;
  let tick;
  let spinnerEl;

  function armSpinner() {
    const verbIdx = Math.floor(Math.random() * SPINNER_VERBS.length);
    const verb    = SPINNER_VERBS[verbIdx];
    body.innerHTML =
      `<span class="thinking">` +
        `<span class="spinner" data-frame="0">${SPINNER_FRAMES[0]}</span> ` +
        `<span class="verb">${verb}…</span>` +
      `</span>`;
    spinnerEl = body.querySelector(".spinner");
    frame = 0;
    tick  = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      if (spinnerEl) spinnerEl.textContent = SPINNER_FRAMES[frame];
    }, 100);
  }
  armSpinner();

  return {
    update(chunk) {
      if (firstToken) {
        clearInterval(tick);
        firstToken = false;
      }
      raw += chunk;
      fullTextBuffer += chunk;
      // Strip tool calls + reasoning; display only the clean answer.
      // Also strip incomplete <tool_call> blocks that haven't closed yet —
      // the stop sequence halts generation at </tool_call> so mid-stream
      // the tag is open and would otherwise bleed into the display.
      const { answer: answerRaw } = parseReasoningAndAnswer(fullTextBuffer);
      let { answer } = parseModelToolCalls(answerRaw);
      answer = answer.replace(/<tool_call>[\s\S]*$/, "").trim();
      body.innerHTML = marked.parse(emphasizeLabels(answer));
      wireInlineArtifactImages(body);
      wireDoctrineCitations(body);
      chatArea.scrollTop = chatArea.scrollHeight;
    },
    // Reset the bubble for a second streaming pass (tool result injected).
    // Clears accumulated text and re-arms the spinner so the operator sees
    // "synthesizing…" while the model generates the final answer.
    reset() {
      clearInterval(tick);
      raw           = "";
      fullTextBuffer = "";
      firstToken    = true;
      armSpinner();
    },
    finalize() {
      clearInterval(tick);
      const { answer: answerRaw, reasoning, hasReasoning } = parseReasoningAndAnswer(fullTextBuffer);
      const { answer: _answer, toolCalls, hasToolCalls } = parseModelToolCalls(answerRaw);
      // Strip any <tool_call> blocks (new format) from the final display
      const answer = _answer.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "").trim();
      body.innerHTML = marked.parse(emphasizeLabels(answer));
      wireInlineArtifactImages(body);
      wireDoctrineCitations(body);
      // Prepend collapsed reasoning trace if the model emitted one
      if (hasReasoning && reasoning) {
        const det = document.createElement("details");
        det.className = "tool-trace";
        const sum = document.createElement("summary");
        sum.textContent = "▸ Thinking";
        det.appendChild(sum);
        const pre = document.createElement("pre");
        pre.className = "tool-trace-body";
        pre.textContent = reasoning;
        det.appendChild(pre);
        wrapper.insertBefore(det, body);
      }
      // Append collapsed tool-call blocks for each model tool invocation
      if (hasToolCalls) {
        for (const tc of toolCalls) {
          const det = document.createElement("details");
          det.className = "tool-trace";
          const sum = document.createElement("summary");
          sum.innerHTML = `<span class="tool-trace-icon">⚙</span> ${escapeAttr(tc.name)}`;
          det.appendChild(sum);
          const pre = document.createElement("pre");
          pre.className = "tool-trace-body";
          // Pretty-print JSON value if parseable
          let body2;
          try { body2 = JSON.stringify(JSON.parse(tc.value), null, 2); }
          catch { body2 = tc.value; }
          pre.textContent = body2;
          det.appendChild(pre);
          wrapper.appendChild(det);
        }
      }
      return { displayText: answer, fullText: fullTextBuffer, reasoning, hasReasoning };
    },
    // Append a visible unverified-data warning bar below the response.
    // Used when the model makes numerical claims without calling a tool.
    appendWarning(html) {
      const warn = document.createElement("div");
      warn.className = "unverified-warning";
      warn.innerHTML = `⚠ <strong>Unverified</strong> — ${html}`;
      wrapper.appendChild(warn);
      chatArea.scrollTop = chatArea.scrollHeight;
    },
    // Append a collapsed tool-call block to this assistant turn.
    // icon: single glyph; label: short summary; detail: expanded body text.
    appendToolCall(icon, label, detail) {
      const det = document.createElement("details");
      det.className = "tool-trace";
      const sum = document.createElement("summary");
      sum.innerHTML = `<span class="tool-trace-icon">${icon}</span> ${escapeAttr(label)}`;
      det.appendChild(sum);
      const pre = document.createElement("pre");
      pre.className = "tool-trace-body";
      pre.textContent = detail;
      det.appendChild(pre);
      wrapper.appendChild(det);
      chatArea.scrollTop = chatArea.scrollHeight;
    },
    // Boot-time restore: paint a complete saved assistant turn in one
    // shot, no streaming spinner. Used by the conversation-restore path.
    // At restore time, text is already just the answer (no reasoning), since
    // we only stored the display text.
    paintFinal(text) {
      clearInterval(tick);
      raw = text || "";
      body.innerHTML = marked.parse(emphasizeLabels(raw));
      wireInlineArtifactImages(body);
      wireDoctrineCitations(body);
      return raw;
    },
    /**
     * Append a compact VPO signature footer to this message. Renders at
     * the bottom of the assistant turn — operator sees provenance class +
     * a sig prefix inline. Full payload (key id, full sig, response_hash,
     * on-disk record) lives in the matching chain block; click the footer
     * to jump there. Avoids duplicating provenance metadata in two places.
     *
     * Shape:
     *   ─ VPO · DEMO · db863554aa76… · 14:32:07 · ↗ open in chain
     */
    attachSignature(envelope) {
      if (!envelope || !envelope.signature) return;
      const cls = classifyKey(envelope.signing_key_id);
      const sigFull  = String(envelope.signature);
      const sigShort = sigFull.slice(0, 12);
      const time = envelope.signed_at
        ? new Date(envelope.signed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "";

      const footer = document.createElement("button");
      footer.type = "button";
      footer.className = `msg-vpo-footer msg-vpo-${cls.class}`;
      footer.title = `${cls.note || ""}\n\nClick to view this decision in the VPO Chain panel.`;
      footer.innerHTML = `
        <span class="msg-vpo-rule">─</span>
        <span class="msg-vpo-tag">VPO</span>
        <span class="msg-vpo-class">${escapeAttr(cls.class.toUpperCase())}</span>
        <code class="msg-vpo-sig">${escapeAttr(sigShort)}…</code>
        <span class="msg-vpo-time">${escapeAttr(time)}</span>
        <span class="msg-vpo-jump">↗ open in chain</span>`;

      footer.addEventListener("click", () => jumpToChainBlock(sigFull));

      wrapper.appendChild(footer);
      chatArea.scrollTop = chatArea.scrollHeight;
    },
  };
}

// Tiny attribute-safe escape — used by attachSignature so user-visible
// signature/key bytes can't break out of the surrounding markup.
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// After marked.js renders an assistant turn, attach a click handler to any
// inline <img> so the same artifact modal (used by the Artifacts tab) opens
// — full-size lightbox with caption — instead of doing nothing or opening
// in a new browser tab. Idempotent: re-runnable on every streaming update
// because we tag wired imgs with data-vpo-wired.
function wireInlineArtifactImages(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll("img:not([data-vpo-wired])").forEach((img) => {
    img.dataset.vpoWired = "1";
    img.style.cursor = "zoom-in";
    img.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openArtifactUrl(img.src, img.alt || "");
    });
  });
}

// ── Doctrine citation linking ─────────────────────────────────────────────
// Builds a keyword → {name, url} lookup from /library items so that inline
// citations like "NIMS 2017", "ICS 201", "ESF 8" become clickable links
// that open the actual PDF from the library corpus.

let _libIndex = null;  // Map<string (lowercase), {name, url}>

function _buildLibIndex(items) {
  const m = new Map();
  const set = (key, entry) => m.set(key.toLowerCase(), entry);
  for (const it of items) {
    const url = `/library/${encodeURIComponent(it.name)}`;
    const entry = { name: it.name, title: it.title, url };
    // ICS forms: ICS-201-*, ICS-205A-*, etc.
    const icsM = it.name.match(/^ICS-(\d{3}[A-Z0-9]*)-/i);
    if (icsM) {
      const n = icsM[1].toUpperCase();
      set(`ics ${n}`, entry); set(`ics-${n}`, entry);
      set(`ics form ${n}`, entry); set(`ics form ics-${n}`, entry);
    }
    // ICS Forms Booklet
    if (/ICS-Forms-Booklet/i.test(it.name)) {
      ["ics forms booklet", "ics forms booklet v3", "ics forms"].forEach(k => set(k, entry));
    }
    // ESF: ESF-08-* → "esf 8", "esf-8", "esf-08", "esf #8"
    const esfM = it.name.match(/^ESF-(\d{2})-/i);
    if (esfM) {
      const n = parseInt(esfM[1], 10);
      [`esf ${n}`, `esf-${n}`, `esf-0${n}`, `esf #${n}`, `esf${n}`].forEach(k => set(k, entry));
    }
    // NIMS Doctrine 2017
    if (/FEMA-NIMS-Doctrine-2017/i.test(it.name)) {
      ["nims 2017", "nims doctrine", "nims doctrine 2017", "nims p-501", "nims p501",
       "nims reference", "nims 2017 doctrine"].forEach(k => set(k, entry));
    }
    // NRF
    if (/FEMA-NRF-3rd/i.test(it.name)) {
      ["nrf", "nrf 3rd edition", "nrf third edition",
       "national response framework", "national response framework 3rd edition"].forEach(k => set(k, entry));
    }
    // NIMS 20-Year Retrospective
    if (/NIMS-20-Years/i.test(it.name)) {
      ["nims 20 years", "nims retrospective"].forEach(k => set(k, entry));
    }
    // NIMS Incident Complexity Guide
    if (/Incident-Complexity/i.test(it.name)) {
      ["nims incident complexity", "incident complexity guide"].forEach(k => set(k, entry));
    }
    // NRF Training Guide
    if (/NRF-Training-Guide/i.test(it.name)) {
      ["nrf training guide"].forEach(k => set(k, entry));
    }
    // NRF Support Annexes
    const annexM = it.name.match(/^NRF-Support-Annex-(.+)\.pdf$/i);
    if (annexM) {
      const slug = annexM[1].replace(/-/g, " ").toLowerCase();
      set(`nrf support annex ${slug}`, entry);
      set(`nrf annex ${slug}`, entry);
    }
  }
  return m;
}

// Pre-fetch at module load; used by wireDoctrineCitations after finalize().
fetch("/library", { cache: "default" })
  .then(r => r.ok ? r.json() : { items: [] })
  .then(d => { _libIndex = _buildLibIndex(d.items || []); })
  .catch(() => { _libIndex = new Map(); });

// Walk text nodes in rootEl, wrap matched citation phrases with <a> tags.
// Skips text inside <a>, <code>, <pre> and nodes already wired.
function wireDoctrineCitations(rootEl) {
  if (!rootEl || !_libIndex || _libIndex.size === 0) return;
  // Build regex from all keys, longest first to prefer specific matches.
  const keys = [..._libIndex.keys()].sort((a, b) => b.length - a.length);
  const escaped = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");

  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let el = node.parentElement;
      while (el && el !== rootEl) {
        if (["A", "CODE", "PRE"].includes(el.tagName)) return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return re.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  const nodes = [];
  let n; while ((n = walker.nextNode())) nodes.push(n);

  for (const textNode of nodes) {
    re.lastIndex = 0;
    const text = textNode.textContent;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      const entry = _libIndex.get(m[0].toLowerCase());
      if (!entry) continue;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement("a");
      a.href = entry.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "doctrine-cite-link";
      a.title = `Open ${entry.title} in Library`;
      a.textContent = m[0];
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (frag.childNodes.length > 1 || frag.firstChild?.nodeType === Node.ELEMENT_NODE) {
      textNode.parentNode?.replaceChild(frag, textNode);
    }
  }
}

// Switch the right-panel tabs to "VPO Chain" and scroll the matching block
// into view with a brief pulse highlight. Wired from each chat message's
// VPO footer so the operator gets one-click drill-down from a chat turn
// to its provenance record.
function jumpToChainBlock(signature) {
  const chainTab = document.querySelector('.tab[data-tab="chain"]');
  if (chainTab) chainTab.click();
  // Wait one frame so the tab pane is visible before scroll/measure.
  requestAnimationFrame(() => {
    const block = document.getElementById(`chain-block-${signature}`);
    if (!block) return;
    block.scrollIntoView({ block: "center", behavior: "smooth" });
    block.classList.remove("chain-block-pulse");
    // Force reflow so the animation restarts if the same block is jumped
    // to twice in a row.
    void block.offsetWidth;
    block.classList.add("chain-block-pulse");
  });
}


// Initialize ICS-201 form with scenario incident name. Called on /demo load
// so all subsequent chat context is captured under a form briefing.
function initFormWithScenario(incidentName) {
  const incidentField = document.getElementById("form-incident");
  if (incidentField && !incidentField.value.trim()) {
    incidentField.value = incidentName;
    console.log(`[form] initialized with incident: ${incidentName}`);
  }
}

// Resolved Ollama base URL after probe ladder. null = no reachable Ollama.
let ollamaBase = null;

async function probeOllama() {
  for (const base of ollamaCandidates()) {
    try {
      const resp = await fetch(`${base}/api/tags`, { method: "GET" });
      if (!resp.ok) {
        // A 503 from the serve.py proxy means the proxy is up but Ollama
        // isn't running — direct port probes will fail identically. Stop here
        // instead of generating CORS noise against :11500/:11434.
        if (base.endsWith("/api/ollama")) break;
        continue;
      }
      const data = await resp.json();
      const matches = (data.models || []).filter(m =>
        (m.name || m.model || "").startsWith(OLLAMA_MODEL)
      );
      if (matches.length) {
        const m = matches[0];
        return {
          base,
          model: m.name || m.model,
          family: m.details?.family || "?",
          quantization: m.details?.quantization_level || "?",
          parameter_size: m.details?.parameter_size || "?",
          size_gb: m.size ? (m.size / 1_000_000_000).toFixed(2) : "?",
        };
      }
    } catch (e) {
      // CORS or connection refused — try the next candidate
    }
  }
  return null;
}

// Boot-time chat restore. Runs BEFORE Ollama probe so the operator sees
// their prior conversation immediately on /reload, with the input
// disabled (probe still pending) at first. Restores up to CONV_MAX_TURNS
// turns. Signature info reattaches the VPO footer with click-to-jump.
async function restoreChatFromIDB() {
  try {
    const saved = await persist.loadConversation();
    if (!saved || !saved.conversation || !saved.renders) return false;
    // Repopulate the in-memory conversation array. Always overwrite the
    // saved system prompt at index 0 with the current SYSTEM_PROMPT —
    // edits to the prompt (e.g. adding the OK/OKC convention) need to
    // apply to restored sessions too, otherwise the model keeps using
    // the stale prompt for everyone who doesn't /clear.
    conversation.length = 0;
    conversation.push({ role: "system", content: SYSTEM_PROMPT });
    for (const m of saved.conversation.slice(1)) conversation.push(m);
    renders.length = 0;
    for (const r of saved.renders) renders.push(r);
    // Repaint each render in order. System messages are skipped (the
    // conversation array carries them but the chat panel never showed
    // them; nothing to repaint).
    for (const r of saved.renders) {
      if (r.role === "user") {
        paintUserMsg(r);
      } else if (r.role === "assistant") {
        const out = appendStreamingAssistant();
        out.paintFinal(r.text || "");
        if (r.signature) {
          out.attachSignature({
            signature: r.signature,
            signing_key_id: r.signing_key_id,
            signed_at: r.signed_at,
          });
        }
      }
    }
    if (saved.renders.length) {
      appendSystemMsg(
        `<strong>Session restored</strong> — ${saved.renders.length} prior turn${saved.renders.length === 1 ? "" : "s"} from ` +
        new Date(saved.saved_at || Date.now()).toLocaleString() +
        ` · use <code>/clear</code> to start fresh.`
      );
    }
    return true;
  } catch (e) {
    console.warn("[restore chat] failed:", e);
    return false;
  }
}

async function initEngine() {
  // Restore prior chat first so operator sees something immediately.
  const hasRestored = await restoreChatFromIDB();
  setStatus("up", "probing local Ollama…");
  chatMeta.textContent = "probing…";

  const found = await probeOllama();
  if (!found) {
    setStatus("down", `Ollama not reachable`);
    footerStat.textContent = `⎇ ${OLLAMA_MODEL} · Ollama not reachable`;
    chatMeta.textContent = "no Ollama";
    if (!hasRestored) {
      appendSystemMsg(
        "<strong>Warning — Ollama not found.</strong> Sending a message will fail until " +
        "<code>ollama serve</code> is running with the <code>severian-ollama</code> model. " +
        "Type freely; the connection is retried on each send."
      );
    }
    promptInput.focus();
    return;
  }

  ollamaBase = found.base;
  setStatus("up", `${found.model} · Gemma 4 · ${found.base}`);
  footerStat.textContent = `⎇ ${found.model} · Gemma 4 · offline`;
  chatMeta.textContent = "ready";
  const micBtn = $("mic"), ttsBtn = $("tts");
  if (micBtn && (window.SpeechRecognition || window.webkitSpeechRecognition)) micBtn.disabled = false;
  if (ttsBtn) ttsBtn.disabled = false;
  promptInput.focus();

  // Always show boot banner so judges see system health on every visit
  if (true) {
    // Fetch health status from serve.py then render the TE NIMS boot banner
    let statusData = null;
    try {
      const sr = await fetch("/status");
      if (sr.ok) statusData = await sr.json();
    } catch { /* serve.py might be absent in dev — banner still renders */ }

    const dotHtml = (s) =>
      s === "ok"   ? `<span style="color:#4caf50">●</span>` :
      s === "warn" ? `<span style="color:#ff9100">●</span>` :
                     `<span style="color:#f44336">●</span>`;

    const checksHtml = statusData
      ? statusData.checks.map(c =>
          `    ${dotHtml(c.status)} <span style="color:var(--te-white)">${c.label.padEnd(17,' ')}</span>` +
          `<span style="opacity:.55">${c.detail}</span>`
        ).join("<br>")
      : `    ${dotHtml("ok")} <span style="color:var(--te-white)">severian-ollama   </span>` +
        `<span style="opacity:.55">${found.model} · Gemma 4</span>`;

    const model = statusData?.model ?? `TE NIMS`;

    appendSystemMsg(`<pre style="font-family:monospace;font-size:11px;line-height:1.35;margin:0;padding:0">` +
`<span style="color:#e8551a"> ████████╗</span><span style="color:#fff">███████╗</span>    <span style="color:#e8551a">  █████╗  ██╗</span>
<span style="color:#e8551a">    ██╔══╝</span><span style="color:#fff">██╔════╝</span>    <span style="color:#e8551a"> ██╔══██╗ ██║</span>
<span style="color:#e8551a">    ██║   </span><span style="color:#fff">█████╗  </span>    <span style="color:#e8551a"> ███████║ ██║</span>
<span style="color:#e8551a">    ██║   </span><span style="color:#fff">██╔══╝  </span>    <span style="color:#e8551a"> ██╔══██║ ██║</span>
<span style="color:#e8551a">    ██║   </span><span style="color:#fff">███████╗</span>    <span style="color:#e8551a"> ██║  ██║ ██║</span>
<span style="color:#e8551a">    ╚═╝   </span><span style="color:#fff">╚══════╝</span>    <span style="color:#e8551a"> ╚═╝  ╚═╝ ╚═╝</span>

<span style="opacity:.55">  Terminus Est AI  ·  </span><span style="color:#fff">TE NIMS Disaster Decision Support on the edge.</span>

  model:    ${model}

  health:
${checksHtml}

  <span style="opacity:.55">type your question · <code>/demo</code> · <code>/buildings</code> · <code>/track</code> · <code>/tiles</code> · <code>/save</code> · <code>/help</code></span></pre>`);
  }
  // Signal that the boot banner is fully rendered — initDemo() waits for this
  // before appending the scenario card so the chat reads top-down:
  //   boot banner → scenario loaded → tour cards
  window.dispatchEvent(new CustomEvent("te:boot-banner-ready"));
}

// Auto-load scenario if URL has ?autoload=demo, OR on a fresh first visit
// with no saved session (web demo — judges land directly into the scenario).
async function initDemo() {
  const _params  = new URLSearchParams(window.location.search);
  const _autoload = _params.get("autoload");
  // Always load the demo scenario on root URL visits (fresh or returning).
  // Saved chat is restored separately by restoreChatFromIDB — map always shows.
  if (_autoload !== null && _autoload !== "demo") return;

  // Clean the URL so a manual reload doesn't re-trigger
  const _clean = new URLSearchParams(window.location.search);
  _clean.delete("autoload");
  const _qs = _clean.toString();
  history.replaceState(null, "", window.location.pathname + (_qs ? "?" + _qs : ""));

  const _loadMsg = appendSystemMsg(
    `<span class="thinking"><span class="spinner" id="demo-load-spinner">⠋</span> Loading scenario…</span>`
  );
  const _spinFrames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let _spinIdx = 0;
  const _spinEl = document.getElementById("demo-load-spinner");
  const _spinTick = setInterval(() => {
    _spinIdx = (_spinIdx + 1) % _spinFrames.length;
    if (_spinEl) _spinEl.textContent = _spinFrames[_spinIdx];
  }, 100);

  try {
    const _r = await fetch("/demo/load", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(10000) });
    if (_r.ok) {
      const { scenario: s } = await _r.json();
      activeScenarioId = s.incident_id;
      bootMap();
      if (tilesBtn) { tilesBtn.hidden = false; tilesBtn.classList.add("active"); tilesBtn.textContent = "🔴 Map"; }
      await Promise.all([
        loadDamageOverlay(),
        loadTrackOverlay().then(() => {
          if (trackBtn) { trackBtn.hidden = false; trackBtn.classList.add("active"); trackBtn.textContent = "🔴 Track"; }
        }),
        loadBuildingsOverlay().then(() => {
          if (buildingsBtn) { buildingsBtn.hidden = false; buildingsBtn.classList.add("active"); buildingsBtn.textContent = "🔴 Buildings"; }
          if (mapLegend) mapLegend.hidden = false;
        }),
      ]);
      // Fit the map to the Moore damage corridor so the track & buildings are centred.
      // [[south, west], [north, east]] — the EF5 swath from Newcastle to SE Moore.
      const mapInst = getMap();
      if (mapInst) {
        mapInst.fitBounds([[35.312, -97.537], [35.348, -97.443]], { padding: [24, 24], maxZoom: 14 });
      }

      const locs = LOCATIONS[s.incident_id] || [];
      if (locs.length) {
        const locLines = locs.map(l =>
          `  • ${l.name} — lat ${l.lat}, lon ${l.lon} (${l.note})`
        ).join("\n");
        conversation.push({
          role: "system",
          content:
            `Known locations for this incident (use for map commands):\n${locLines}\n\n` +
            `To place a pin: [MAP:pin:LAT,LON:Label] — e.g. [MAP:pin:35.3254,-97.4876:Plaza Towers Elementary]\n` +
            `To zoom the map: [MAP:zoom:LAT,LON] — e.g. [MAP:zoom:35.3254,-97.4876]\n` +
            `Use plain decimal numbers only — no "lat=" or "lon=" prefixes.`,
        });
      }

      initFormWithScenario(s.incident_name || s.incident_id);
      clearInterval(_spinTick);
      if (_loadMsg) _loadMsg.remove();
      // Wait for the boot banner so the chat reads top-down:
      //   boot banner (system health) → scenario card → tour
      await new Promise(resolve => {
        const banner = chatArea.querySelector("pre");
        if (banner && banner.textContent.includes("TE NIMS")) { resolve(); return; }
        const timeout = setTimeout(resolve, 3500);
        window.addEventListener("te:boot-banner-ready", () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      appendSystemMsg(
        `<pre style="font-family:monospace;font-size:11px;line-height:1.4;margin:0">` +
        `<span style="color:#e8551a">✅ ${s.incident_name} scenario loaded.</span>\n\n` +
        `  📍 <strong>Scenario:</strong> ${s.location} — ${s.date}\n` +
        `  🌪  <strong>Track:</strong>   ${s.track}\n` +
        `  🏚  <strong>Damage:</strong>  ${s.damage}\n` +
        `  🎯 <strong>Critical nodes:</strong>\n` +
        `     ${(s.critical_nodes || []).map(n => `• ${n.name} — ${n.note}`).join("\n     ")}\n\n` +
        `  <span style="opacity:.55">${s.hint || ""}</span></pre>`
      );

      // Seed the VPO chain with a signed ICS-201 incident-open genesis block.
      // Runs fire-and-forget so a slow VPO server never delays the demo load.
      (async () => {
        try {
          const payload = {
            form_type: "incident_open",
            form_data: {
              ics_form:      "ICS-201",
              incident_id:   s.incident_id,
              incident_name: s.incident_name,
              location:      s.location,
              date:          s.date,
              status:        "OPENED",
              critical_nodes: s.critical_nodes || [],
            },
            signer:    "fob-operator",
            signed_at: new Date().toISOString(),
          };
          const resp = await fetch("/vpo/sign", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify(payload),
            signal:  AbortSignal.timeout(8000),
          });
          if (resp.ok) {
            const envelope = await resp.json();
            window.dispatchEvent(new CustomEvent("vpo:add-block", { detail: envelope }));
          }
        } catch (e) {
          console.warn("[demo] VPO genesis block failed:", e);
        }
      })();

      return;
    }
  } catch { /* non-fatal */ }
  clearInterval(_spinTick);
  if (_loadMsg) _loadMsg.remove();
  // Wire the "Demo Walkthrough" header button — wires here so it has access
  // (tour button wired unconditionally at module load — see bottom of file)
}

// Sign a completed chat turn (question + assistant response) via WebCrypto
// HMAC-SHA256 — same scheme + key as form.js signForm so every block in the
// chain shares the same signer regardless of source. The result is a VPO
// envelope dispatched on `vpo:add-block`; chain.js picks it up, links it to
// the previous block's signature, and persists in IndexedDB.
// Signing identity — fetched from the server at boot via GET /signing-key.
// The server reads data/.signing-key.json (or env override) and returns
// {key_id, key, scheme, loaded_from}. If the fetch fails, fall back to a
// known-public demo key so the SPA still works offline / in dev. The
// classification banner in chain.js + footer chip flip from yellow→green
// automatically when key_id stops starting with "demo:" / "training:".
const _DEMO_KEY = {
  key_id:      "demo:te-nims-fob-demo-key",
  key:         "te-nims-fob-demo-key",
  scheme:      "HMAC-SHA256",
  loaded_from: "default-fallback",
};
let VPO_SIGNING_IDENTITY = _DEMO_KEY;   // updated by initSigningIdentity()
const VPO_TURN_RESPONSE_CAP = 4000;

// Hardcoded ONLY as regression-search anchors — the runtime uses
// VPO_SIGNING_IDENTITY.{key,key_id}. Both fields exist purely so wiring
// tests can grep for them and so form.js's matching key-string still lines up.
const VPO_TURN_SIGNING_KEY    = _DEMO_KEY.key;
const VPO_TURN_SIGNING_KEY_ID = _DEMO_KEY.key_id;

async function initSigningIdentity() {
  try {
    const resp = await fetch("/signing-key", { cache: "no-store" });
    if (!resp.ok) {
      window.__TE_SIGNING_IDENTITY__ = VPO_SIGNING_IDENTITY;  // expose demo fallback
      return;
    }
    const spec = await resp.json();
    if (spec && spec.key_id && spec.key) {
      VPO_SIGNING_IDENTITY = spec;
      console.info(`[vpo] active signing identity: ${spec.key_id} (${spec.loaded_from || "?"})`);
    }
  } catch (e) {
    console.warn("[vpo] /signing-key fetch failed, using demo fallback:", e);
  }
  // F-3: expose the ACTIVE identity so chain.js's banner classifies based
  // on what we actually signed with, not on each envelope's claim. The
  // banner reads window.__TE_SIGNING_IDENTITY__ in renderKeyBanner.
  window.__TE_SIGNING_IDENTITY__ = VPO_SIGNING_IDENTITY;
}
// Kick fetch at module load. signChatTurn reads VPO_SIGNING_IDENTITY at
// sign time, so even if the boot fetch hasn't resolved by the time the
// first turn signs, later turns automatically pick up the loaded identity.
initSigningIdentity();

// Sign a chat turn via the server's VPO signing endpoint.
// PHASE 1: Remove local HMAC signing. Throws error until Phase 2 /vpo/sign is ready.
// PHASE 2: Will POST to /vpo/sign endpoint which calls the Rust vpo-server for Ed25519.
async function signChatTurn(question, response, signer = "severian-agent", prevHash = null) {
  const payload = {
    form_type:     "chat_turn",
    form_data: {
      block_kind:    "chat_turn",
      question:      question,
      response:      response,
      response_full_length: response.length,
    },
    signed_at:     new Date().toISOString(),
    signer:        signer,
  };

  // Add prev_hash if available (for chain linking)
  if (prevHash) {
    payload.prev_hash = prevHash;
  }

  const resp = await fetch("/vpo/sign", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`[app] /vpo/sign failed: ${resp.status} ${err}`);
  }

  return resp.json();
}

// Build the request payload + endpoint for a chat turn. Vision endpoint
// (llama-server, OpenAI format) is used whenever the most recent user
// message has images attached; otherwise Ollama. Two endpoints because
// Ollama's bundled llama.cpp doesn't yet recognize the gemma4 GGUF
// architecture so vision must run via our standalone llama-server build.
// Re-encode every image through the browser's decoder → canvas → JPEG before
// sending to llama-server. Always re-encodes (even "safe" JPEG/PNG) so that
// a file claiming to be JPEG but containing HEIC bytes (iOS canvas fallback)
// gets corrected before it reaches stb_image. Cost: ~100-300ms per image,
// negligible compared to vision inference time.
async function _ensureVisionCompatible(dataUrl, mime) {
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload  = () => resolve(el);
      el.onerror = () => reject(new Error("cannot decode image"));
      el.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width  = img.naturalWidth  || 1920;
    canvas.height = img.naturalHeight || 1080;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const jpeg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    if (!jpeg) return { dataUrl, mime };
    const out = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload  = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(jpeg);
    });
    return { dataUrl: out, mime: "image/jpeg" };
  } catch {
    return { dataUrl, mime };   // pass through unchanged on decode error
  }
}

async function buildChatRequest(conversation, hasImages) {
  if (hasImages) {
    const visionUrl = visionEndpoint();
    // Only attach images to the LATEST user message. llama.cpp's mtmd
    // can't handle multiple historical images in one prompt — it errors
    // with "number of bitmaps does not match number of markers". Strip
    // images from every prior turn; convert them to plain text references.
    let lastUserIdx = -1;
    for (let i = conversation.length - 1; i >= 0; i--) {
      if (conversation[i].role === "user" &&
          Array.isArray(conversation[i].images) &&
          conversation[i].images.length) {
        lastUserIdx = i;
        break;
      }
    }
    const oaiMessages = await Promise.all(conversation.map(async (m, i) => {
      const hasImgs = Array.isArray(m.images) && m.images.length;
      // Historical image turns: drop the image, keep the text reference
      if (hasImgs && i !== lastUserIdx) {
        return {
          role: m.role,
          content: (m.content || "") + " [image attached in earlier turn]",
        };
      }
      if (hasImgs && i === lastUserIdx) {
        const parts = [{ type: "text", text: m.content || "" }];
        for (const img of m.images) {
          const rawB64  = typeof img === "string" ? img : img.base64;
          const rawMime = typeof img === "string" ? "image/jpeg" : (img.mime || "image/jpeg");
          const rawUrl  = `data:${rawMime};base64,${rawB64}`;
          let url = rawUrl;
          try {
            ({ dataUrl: url } = await _ensureVisionCompatible(rawUrl, rawMime));
          } catch { /* send as-is on error */ }
          parts.push({ type: "image_url", image_url: { url } });
        }
        return { role: m.role, content: parts };
      }
      return { role: m.role, content: m.content || "" };
    }));
    return {
      url: `${visionUrl}/v1/chat/completions`,
      body: JSON.stringify({
        model: "severian-vision",
        messages: oaiMessages,
        max_tokens: 1024,
        stream: true,
        chat_template_kwargs: { enable_thinking: false },
      }),
      streamFormat: "sse",
    };
  }
  // Ollama /api/chat expects images as plain base64 strings, not {base64,mime}
  // objects. Normalize so a mixed conversation (prior vision turn + text turn)
  // doesn't send malformed messages and get a 400.
  const ollamaMessages = conversation.map((m) => {
    if (!Array.isArray(m.images) || !m.images.length) return m;
    return { ...m, images: m.images.map((img) => typeof img === "string" ? img : img.base64) };
  });
  return {
    url: `${ollamaBase}/api/chat`,
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: ollamaMessages,
      stream: true,
      keep_alive: -1,
      // Stop at </tool_call> for our ReAct protocol.
      // NOTE: we do NOT add a stop sequence for the model's trained
      // response:ics_tools.X{value:<|"|>...} format — the <| prefix is
      // interpreted as a special token by llama.cpp and causes an empty
      // response crash. The old format is detected post-stream in runToolRound
      // after the model has finished generating (we discard the hallucinated value).
      stop: ["</tool_call>"],
      options: {
        num_ctx: 8192,
        num_predict: 1024,
        cache_prompt: true,
      },
    }),
    streamFormat: "ndjson",
  };
}

// Read NDJSON (Ollama) or SSE (OpenAI) deltas from a fetch response.
// Calls onToken(text) for each content delta. Returns the accumulated
// final text once the stream terminates.
async function readStream(resp, format, onToken) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acc = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const sep = format === "sse" ? "\n\n" : "\n";
    const lines = buffer.split(sep);
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        if (format === "sse") {
          // SSE lines look like `data: {...}` or `data: [DONE]`
          const dataMatch = line.match(/^data:\s*(.*)$/m);
          if (!dataMatch) continue;
          const payload = dataMatch[1].trim();
          if (payload === "[DONE]") return acc;
          const obj = JSON.parse(payload);
          const delta = obj.choices?.[0]?.delta?.content
                     || obj.choices?.[0]?.delta?.reasoning_content
                     || "";
          if (delta) { acc += delta; onToken(delta); }
        } else {
          const obj = JSON.parse(line);
          const tok = obj.message?.content || "";
          if (tok) { acc += tok; onToken(tok); }
        }
      } catch {
        // Skip malformed lines
      }
    }
  }
  return acc;
}

// ── Mem0 session memory helpers ──────────────────────────────────────
// Both surfaces (CLI chat.py + web) write to the same Qdrant collection
// at ~/.severian/chats/qdrant via /memory/* endpoints on serve.py.

async function fetchMemoryContext(query) {
  try {
    const r = await fetch("/memory/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.has_context ? d.context : null;
  } catch { return null; }
}

async function storeMemoryTurn(question, answer) {
  try {
    await fetch("/memory/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, answer }),
    });
  } catch { /* fire-and-forget: failures are non-fatal */ }
}

// ── ReAct tool execution helpers ─────────────────────────────────────────
// Execute a named tool on serve.py and return its JSON result.
async function executeTool(name, args, signal) {
  const resp = await fetch(`/tools/${encodeURIComponent(name)}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(args || {}),
    signal,
  });
  if (!resp.ok) throw new Error(`/tools/${name} → HTTP ${resp.status}`);
  return resp.json();
}

// Map from the model's trained ics_tools.* names → our serve.py tool names.
const ICS_TOOL_MAP = {
  "ics_tools.get_damage_summary":                  "get_damage_summary",
  "ics_tools.get_incident":                        "get_scenario_info",
  "ics_tools.get_scenario":                        "get_scenario_info",
  "ics_tools.get_resources":                       "list_resources",
  "ics_tools.list_resources":                      "list_resources",
  "ics_tools.search_doctrine":                     "search_doctrine",
  "ics_tools.search":                              "search_doctrine",
  "ics_tools.geo_resolve_closest_medical_facility": "find_closest",
  "ics_tools.find_nearest_hospital":               "find_closest",
  "ics_tools.find_closest":                        "find_closest",
  // geo_tools namespace
  "geo_tools.geo_resolve_aoi":                     "geo_resolve_aoi",
  "geo_tools.geo_resolve_closest_medical_facility": "find_closest",
  "geo_tools.find_nearest_hospital":               "find_closest",
  "geo_tools.find_nearest_shelter":                "find_closest",
  // odin_tools namespace
  "odin_tools.geo_resolve_aoi":                    "geo_resolve_aoi",
  "odin_tools.geo_resolve_closest_medical_facility": "find_closest",
  "odin_tools.find_nearest_hospital":              "find_closest",
  "odin_tools.find_nearest_shelter":               "find_closest",
  "odin_tools.list_resources":                     "list_resources",
  "odin_tools.query_layer":                        "odin_tools.query_layer",
};

// If `streamedText` contains a <tool_call> block OR the model's trained
// response:ics_tools.* format: parse it, POST to serve.py, append result
// traces to `out`, push both turns into `conversation`, call out.reset(),
// and stream the final answer into the same bubble.
// Returns the final answer text, or null if no tool call was detected.
async function runToolRound(out, streamedText, req, signal) {
  let toolName, toolArgs;

  // ── Format A: our <tool_call> ReAct protocol ──────────────────────
  const TC_OPEN = "<tool_call>";
  const tcIdx   = streamedText.indexOf(TC_OPEN);
  if (tcIdx !== -1) {
    const tcRaw = streamedText
      .slice(tcIdx + TC_OPEN.length)
      .replace(/<\/tool_call>[\s\S]*$/, "")
      .trim();
    try {
      const tc = JSON.parse(tcRaw);
      toolName = tc.name;
      toolArgs = tc.args || {};
    } catch (e) {
      console.warn("[react] <tool_call> parse error:", e.message, tcRaw.slice(0, 80));
    }
  }

  // ── Format B: model's trained response:ics_tools.* format ─────────
  // The stop sequence {value:<|"|> fires before the hallucinated value,
  // so streamedText ends with `response:ics_tools.X{value:` (no payload).
  // We discard whatever the model would have invented and call the real tool.
  if (!toolName) {
    const oldMatch = streamedText.match(/response:([\w.]+)\{value:/);
    if (oldMatch) {
      const rawName = oldMatch[1];
      toolName = ICS_TOOL_MAP[rawName] ?? rawName.split(".").pop();
      toolArgs = {};
      console.log("[react] intercepted ics_tools call:", rawName, "→", toolName);
    }
  }

  if (!toolName) return null;

  // Tool trace intentionally suppressed — keeps the chat clean for operators.

  let toolResult;
  try {
    toolResult = await executeTool(toolName, toolArgs, signal);
  } catch (e) {
    toolResult = { error: String(e) };
  }

  // Result detail intentionally not shown in UI — keeps chat clean for operators.

  // Inject the tool call + result into the conversation for the second pass.
  // The model sees: ..., assistant(tool call), user(tool result), and responds
  // with the grounded final answer.
  conversation.push({ role: "assistant", content: streamedText });
  conversation.push({
    role: "user",
    content:
      `<tool_result name="${toolName}">\n${JSON.stringify(toolResult, null, 2)}\n</tool_result>\n\n` +
      `Now answer the operator's original question using the tool result above.`,
  });

  // Reset the bubble — clears the tool-call text and shows "synthesizing…"
  out.reset();

  // Second pass: final answer (no stop sequences needed here)
  const req2 = await buildChatRequest(conversation, false);
  const body2 = JSON.parse(req2.body);
  body2.stop = [];  // don't stop on </tool_call> for the final answer pass
  const resp2 = await fetch(req2.url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body2),
    signal,
  });
  if (!resp2.ok) throw new Error(`ollama second pass → HTTP ${resp2.status}`);

  let finalText = "";
  await readStream(resp2, req2.streamFormat, (tok) => {
    finalText += tok;
    out.update(tok);
  });
  return finalText;
}

async function sendQuery(question, images = [], documents = []) {
  if (!ollamaBase) {
    // Re-probe on every send attempt so the user doesn't need to reload
    // after Ollama starts up later.
    const found = await probeOllama();
    if (!found) {
      appendSystemMsg("<strong>Ollama not reachable.</strong> Ensure <code>ollama serve</code> is running with the <code>severian-ollama</code> model, then try again.");
      return;
    }
    ollamaBase = found.base;
    setStatus("up", `${found.model} · Gemma 4 · ${found.base}`);
    footerStat.textContent = `⎇ ${found.model} · Gemma 4 · offline`;
    chatMeta.textContent = "ready";
  }
  appendUserMsg(question, images, documents);
  // Record this user turn for persistence. Image dataUrls and document
  // metadata go in verbatim so /reload can repaint identically.
  renders.push({
    role: "user",
    text: question,
    images: images.map((img) => ({
      name:      img.name,
      mime:      img.mime,
      dataUrl:   img.dataUrl,
      sourceUrl: img.sourceUrl || null,
    })),
    documents: documents.map((d) => ({
      name:   d.name,
      title:  d.title,
      url:    d.url,
      doc_id: d.doc_id,
      chunks: d.chunks || 0,
      status: d.status,
    })),
  });

  // Document RAG: for each ready doc, fetch top-k chunks for this query
  // and prepend a single SYSTEM message with the retrieved context. The
  // model is instructed to ground its answer in the chunks and cite the
  // page numbers. Done before the user message lands in `conversation`
  // so the LLM sees: [system prompt, ..., system context, user query].
  const readyDocs = documents.filter((d) => d.status === "ready" && (d.doc_id || d.preText));
  if (readyDocs.length) {
    chatMeta.textContent = "retrieving doctrine…";
    try {
      const ctxBlocks = [];
      for (const d of readyDocs) {
        // Pre-fetched artifact text (HTML saved responses, uploaded files) —
        // skip the RAG round-trip and inject the content directly.
        if (d.preText) {
          ctxBlocks.push(`<context source="${d.title || d.name}">\n${d.preText}\n</context>`);
          continue;
        }
        const r = await fetch("/document/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc_id: d.doc_id, query: question, k: 4 }),
        });
        if (!r.ok) {
          console.warn("[document/query] failed:", r.status);
          continue;
        }
        const j = await r.json();
        const matches = (j.matches || [])
          .map((m) => `[page ${m.page}] ${m.text.replace(/\s+/g, " ").trim()}`)
          .join("\n\n");
        if (matches) {
          ctxBlocks.push(
            `<context source="${j.title || j.name}">\n${matches}\n</context>`,
          );
        }
      }
      if (ctxBlocks.length) {
        const ctxMsg = {
          role: "system",
          content:
            "The operator dragged the following documents into chat. Ground your answer in these excerpts and cite the page numbers in square brackets like [page 5] when you reference a specific passage. If the documents don't contain the answer, say so explicitly.\n\n" +
            ctxBlocks.join("\n\n"),
        };
        conversation.push(ctxMsg);
      }
    } catch (e) {
      console.warn("[rag] retrieval failed:", e);
    }
  }

  // Memory context: inject relevant prior-turn facts before the user message
  // so the model sees cross-session context. Same pattern as document RAG above.
  try {
    const memCtx = await fetchMemoryContext(question);
    if (memCtx) {
      conversation.push({ role: "system", content: memCtx });
    }
  } catch { /* non-fatal */ }

  // Use Ollama-style internal representation (content string + images
  // base64 array). buildChatRequest() translates to OpenAI format when
  // routing to the vision endpoint.
  const userMsg = { role: "user", content: question };
  if (images.length) {
    // Store {base64, mime} so buildChatRequest can set the correct Content-Type
    // in the data URI — llama-server rejects images with a mismatched MIME type.
    userMsg.images = images.map((img) => ({ base64: img.base64, mime: img.mime || "image/jpeg" }));
  }
  conversation.push(userMsg);

  promptInput.disabled = true;
  sendButton.disabled  = true;
  promptInput.value    = "";
  const route = images.length ? "vision" : (readyDocs.length ? "ollama+rag" : "ollama");
  chatMeta.textContent = `thinking… (${route})`;

  const out = appendStreamingAssistant();
  const controller = new AbortController();
  const onEsc = (ev) => {
    if (ev.key === "Escape") {
      controller.abort();
      stopSpeaking();
    }
  };
  document.addEventListener("keydown", onEsc);

  try {
    const req = await buildChatRequest(conversation, images.length > 0);
    if (req.error) {
      out.update(`\n\n_[${req.error}]_`);
      throw new Error(req.error);
    }
    const resp = await fetch(req.url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    req.body,
      signal:  controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      out.update(`\n\n_[HTTP ${resp.status}: ${body.slice(0, 200)}]_`);
      throw new Error(`HTTP ${resp.status}`);
    }

    let streamedText = "";
    await readStream(resp, req.streamFormat, (tok) => {
      streamedText += tok;
      out.update(tok);
    });

    // ── ReAct tool loop ───────────────────────────────────────────────
    // If the model emitted a <tool_call> block, execute the tool and stream
    // a second pass (the grounded final answer) into the same bubble.
    // Vision requests skip the loop — tool calls don't mix with image turns.
    let toolWasCalled = false;
    if (!images.length) {
      try {
        chatMeta.textContent = "executing tool…";
        const toolFinalText = await runToolRound(out, streamedText, req, controller.signal);
        if (toolFinalText !== null) {
          toolWasCalled = true;
          chatMeta.textContent = "thinking…";
        }
      } catch (toolErr) {
        console.warn("[react] tool round failed:", toolErr);
        out.appendToolCall("⚠", "tool execution error", String(toolErr));
      }
    }

    // finalize() returns { displayText, fullText, reasoning, hasReasoning }
    const result = out.finalize();
    const acc = result.displayText || "";  // Display text is what goes in conversation
    const fullResponseText = result.fullText || "";  // Full text (with reasoning) for logging

    if (result.hasReasoning && result.reasoning) {
      console.log("[vpo-trace] reasoning detected:", result.reasoning.slice(0, 200));
    }

    // ── Unverified data warning ───────────────────────────────────────
    // If the response makes specific numerical claims (damage counts,
    // resource numbers, casualty figures) but no tool was called to
    // retrieve live data, flag the answer as potentially hallucinated.
    const DATA_CLAIM_RE = /\b\d+\b.{0,60}\b(building|structur|casualt|kill|destroy|damage|resource|unit|team|bed|victim|survivor|personnel|ambu|hospital)\b/i;
    if (!toolWasCalled && !images.length && DATA_CLAIM_RE.test(acc)) {
      out.appendWarning(
        "No tool was called — these figures were not retrieved from live data and may be hallucinated."
      );
    }

    // Parse and execute [MAP:pin:lat,lon:label] / [MAP:zoom:lat,lon:zoom] commands
    const MAP_CMD_RE = /\[MAP:(pin|zoom):(?:lat=)?(-?\d+\.?\d*),(?:lon=)?(-?\d+\.?\d*)(?::([^\]]*))?\]/gi;
    let mapMatch;
    while ((mapMatch = MAP_CMD_RE.exec(acc)) !== null) {
      const [, cmd, latStr, lonStr, arg] = mapMatch;
      const lat = parseFloat(latStr), lon = parseFloat(lonStr);
      if (cmd === "pin") {
        addPin("incident", lat, lon, arg || "Pinned location", "Agent · " + new Date().toLocaleTimeString());
        zoomTo(lat, lon, 16);
        out.appendToolCall("📍", `pin_drop · ${arg || "Pinned location"}`,
          `lat:   ${lat}\nlon:   ${lon}\nlabel: ${arg || "Pinned location"}`);
      } else if (cmd === "zoom") {
        const z = arg && !isNaN(parseInt(arg)) ? parseInt(arg) : 16;
        zoomTo(lat, lon, z);
        out.appendToolCall("🔍", `map_zoom · ${lat}, ${lon}`,
          `lat:  ${lat}\nlon:  ${lon}\nzoom: ${z}`);
      }
    }

    // Parse and execute [MAP:layer:NAME:on|off] — show/hide map overlays
    const MAP_LAYER_RE = /\[MAP:layer:(buildings|track|tiles)(?::(on|off))?\]/gi;
    let layerMatch;
    while ((layerMatch = MAP_LAYER_RE.exec(acc)) !== null) {
      const [, layerName, state] = layerMatch;
      const turnOn = state !== "off";  // default: show

      // Determine current visibility and toggle only if needed
      const layerMap = {
        buildings: { btn: buildingsBtn, toggle: toggleBuildingsOverlay, label: "Buildings" },
        track:     { btn: trackBtn,     toggle: toggleTrackOverlay,     label: "Track" },
        tiles:     { btn: tilesBtn,     toggle: toggleTileLayer,        label: "Map" },
      };
      const lyr = layerMap[layerName];
      if (lyr) {
        const isOn = lyr.btn?.classList.contains("active");
        if (turnOn !== isOn) {
          const nowOn = lyr.toggle();
          lyr.btn?.classList.toggle("active", nowOn);
          if (lyr.btn) lyr.btn.textContent = nowOn ? `🔴 ${lyr.label}` : `⬛ ${lyr.label}`;
          if (layerName === "buildings" && mapLegend) mapLegend.hidden = !nowOn;
        }
        out.appendToolCall("🗂", `layer_${turnOn ? "show" : "hide"} · ${layerName}`, `layer: ${layerName}\nstate: ${turnOn ? "on" : "off"}`);
      }
    }

    conversation.push({ role: "assistant", content: acc });
    // Store this turn in the shared Mem0 memory (fire-and-forget).
    storeMemoryTurn(question, acc);
    // Persisted render for assistant turn. Signature etc. fill in later
    // (after VPO signing) via a back-reference; for now record the text
    // so a reload right after stream-end still shows the turn.
    const assistantRender = { role: "assistant", text: acc };
    renders.push(assistantRender);
    // If TTS is enabled, speak the response. Strip markdown first.
    speak(acc);
    // VPO sign + chain — runs in the background so it never blocks the UI.
    // The input re-enables immediately after the stream; the signature footer
    // appears on the bubble a moment later once signing completes.
    if (acc.trim().length > 0) {
      (async () => {
        try {
          const prevHash = await getLastBlockHash();
          const fullEnvelope = await signChatTurn(question, acc, "severian-agent", prevHash);
          let logPath = null;
          try {
            const resp = await fetch("/chat-log", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(fullEnvelope),
              signal: AbortSignal.timeout(8000),
            });
            if (resp.ok) {
              const j = await resp.json();
              logPath = j.log_path || null;
            } else {
              console.warn("[vpo] /chat-log POST failed:", resp.status);
            }
          } catch (postErr) {
            console.warn("[vpo] /chat-log unreachable:", postErr);
          }
          const truncated = acc.length > VPO_TURN_RESPONSE_CAP
            ? acc.slice(0, VPO_TURN_RESPONSE_CAP) + "…"
            : acc;
          const chainEnvelope = {
            ...fullEnvelope,
            response: truncated,
            response_truncated: acc.length > VPO_TURN_RESPONSE_CAP,
            log_path: logPath,
          };
          if (typeof out.attachSignature === "function") {
            out.attachSignature(chainEnvelope);
          }
          assistantRender.signature      = chainEnvelope.signature;
          assistantRender.signing_key_id = chainEnvelope.signing_key_id;
          assistantRender.signed_at      = chainEnvelope.signed_at;
          window.dispatchEvent(new CustomEvent("vpo:add-block", { detail: chainEnvelope }));
          persistChat();
        } catch (e) {
          console.warn("[vpo] chat-turn signing failed:", e);
        }
      })();
    } else {
      persistChat();
    }
  } catch (err) {
    if (err.name === "AbortError") {
      out.update("\n\n_[interrupted by ESC]_");
    } else {
      out.update(`\n\n_[error: ${err.message}]_`);
    }
  } finally {
    document.removeEventListener("keydown", onEsc);
    promptInput.disabled = false;
    sendButton.disabled  = false;
    chatMeta.textContent = "ready";
    promptInput.focus();
    window.dispatchEvent(new CustomEvent("te:response-complete"));
  }
}

// ── Slash commands ──────────────────────────────────────────────────
// Minimal local-only commands that don't touch the model. Add more as
// they prove useful. Each returns true if it consumed the input, false
// to fall through to sendQuery().
// Active scenario state — populated by /demo, cleared by /reset
let activeScenarioId = null;

// ── Nuclear wipe + reload ─────────────────────────────────────────────
// Wipes every layer of state so the next boot feels like a fresh FOB install.
// autoload: null = plain reload; "demo" = reload to /?autoload=demo
async function _fullNukeAndReload(autoload) {
  // 1. Server-side: chain, chat-log, document-cache, Mem0
  try {
    await fetch("/demo/reset", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch (e) { /* server down — still wipe browser */ }

  // 2. Service workers
  if ("serviceWorker" in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    } catch (e) { /* ignore */ }
  }

  // 3. Cache API (pre-cached assets, API responses)
  if ("caches" in window) {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (e) { /* ignore */ }
  }

  // 4. All localStorage (doc index, map state, TTS toggle, etc.)
  try { localStorage.clear(); } catch (e) { /* ignore */ }

  // 5. All sessionStorage — re-stamp SW reload guard immediately after clear so
  // the controllerchange handler (index.html) doesn't fire a second reload when
  // the new SW activates via clients.claim() on the ?autoload=demo boot.
  try {
    sessionStorage.clear();
    sessionStorage.setItem("te-sw-reloaded", String(Date.now()));
  } catch (e) { /* ignore */ }

  // 6. IndexedDB databases (conversation history, VPO chain blocks)
  try {
    const dbs = await indexedDB.databases();
    // Use a 5-second timeout per db — if deletion hangs, don't block the reload
    await Promise.all(dbs.map(d => {
      return Promise.race([
        new Promise((res) => {
          const req = indexedDB.deleteDatabase(d.name);
          req.onsuccess = req.onerror = res;
        }),
        new Promise((res) => {
          setTimeout(res, 5000);
        })
      ]);
    }));
  } catch (e) { /* ignore */ }

  // 7. Reload — build fresh URL preserving the ollama param
  const params = new URLSearchParams(window.location.search);
  const ollama = params.get("ollama");
  let url = window.location.pathname;
  const qs = new URLSearchParams();
  if (ollama) qs.set("ollama", ollama);
  if (autoload) qs.set("autoload", autoload);
  // When loading demo, set scenario to moore-tornado-2013 so activeScenario() picks it
  if (autoload === "demo") qs.set("scenario", "moore-tornado-2013");
  const qstr = qs.toString();
  window.location.replace(url + (qstr ? "?" + qstr : ""));
}

const SLASH_COMMANDS = {
  "/reset": async () => {
    // True "fresh FOB install" wipe:
    //   1. Server: chain, chat-log, document-cache, Mem0
    //   2. Browser: service workers, Cache API, localStorage, IndexedDB
    //   3. Hard reload — boots exactly like first launch
    appendSystemMsg("Wiping all state — reloading as fresh install…");
    await _fullNukeAndReload(null);
  },
  "/demo": async () => {
    // Same nuclear wipe then reload to /?autoload=demo so the scenario
    // card renders automatically after boot — feels like first power-on.
    appendSystemMsg("Wiping state and loading demo scenario…");
    await _fullNukeAndReload("demo");
  },
  "/reload": async () => {
    // Hard reload: clears all client state + resets ICS form versions to originals.
    if (!confirm("Reload will clear all state and reset ICS forms to their original versions. Continue?")) return;
    appendSystemMsg("Resetting ICS form versions and wiping all state…");
    await fetch("/ics-forms/reset", { method: "POST" }).catch(() => {});
    await _fullNukeAndReload(null);
  },
  "/clear":  async () => {
    chatArea.querySelectorAll(".msg.user, .msg.assistant").forEach(el => el.remove());
    conversation.length = 1;  // keep the system prompt at index 0
    renders.length = 0;
    await persist.clearConversation();
    appendSystemMsg("Chat cleared. System prompt preserved. Saved session removed.");
  },
  "/reset-chain": async () => {
    if (window.teResetChain) {
      await window.teResetChain();
      appendSystemMsg("VPO chain reset.");
    }
  },
  "/buildings": () => {
    if (!buildingsBtn || buildingsBtn.hidden) { appendSystemMsg("Buildings layer not loaded — run <code>/demo</code> first."); return Promise.resolve(); }
    const nowOn = toggleBuildingsOverlay();
    buildingsBtn.classList.toggle("active", nowOn);
    buildingsBtn.textContent = nowOn ? "🔴 Buildings" : "⬛ Buildings";
    if (mapLegend) mapLegend.hidden = !nowOn;
    appendSystemMsg(`Buildings damage layer ${nowOn ? "shown" : "hidden"}.`);
    return Promise.resolve();
  },
  "/track": () => {
    if (!trackBtn || trackBtn.hidden) { appendSystemMsg("Track layer not loaded — run <code>/demo</code> first."); return Promise.resolve(); }
    const nowOn = toggleTrackOverlay();
    trackBtn.classList.toggle("active", nowOn);
    trackBtn.textContent = nowOn ? "🔴 Track" : "⬛ Track";
    appendSystemMsg(`Tornado track ${nowOn ? "shown" : "hidden"}.`);
    return Promise.resolve();
  },
  "/tiles": () => {
    if (!tilesBtn || tilesBtn.hidden) { appendSystemMsg("Map not loaded — run <code>/demo</code> first."); return Promise.resolve(); }
    const nowOn = toggleTileLayer();
    tilesBtn.classList.toggle("active", nowOn);
    tilesBtn.textContent = nowOn ? "🔴 Map" : "⬛ Map";
    appendSystemMsg(`Base map tiles ${nowOn ? "shown" : "hidden"}.`);
    return Promise.resolve();
  },
  "/save": async () => {
    // Save the last assistant response as an HTML doc artifact in the Artifacts tab.
    const lastAssistant = [...chatArea.querySelectorAll(".msg.assistant")]
      .filter(el => !el.classList.contains("streaming"))
      .pop();
    if (!lastAssistant) {
      appendSystemMsg("Nothing to save — no assistant response yet.");
      return;
    }
    // Use innerText for the title (first line, truncated) and the rendered HTML for the body
    const rawText  = (lastAssistant.innerText || "").trim();
    const firstLine = rawText.split("\n")[0].slice(0, 60) || "Response";
    const innerHtml = lastAssistant.querySelector(".msg-content")?.innerHTML
                   || lastAssistant.innerHTML;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${firstLine.replace(/</g,"&lt;")}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem;
         background: #111; color: #e8e8e8; line-height: 1.6; }
  h1,h2,h3 { color: #fff; } table { border-collapse: collapse; width: 100%; }
  th,td { border: 1px solid #333; padding: .4em .7em; }
  th { background: #222; } tr:nth-child(even) { background: #1a1a1a; }
  code { background: #222; padding: .1em .3em; border-radius: 3px; }
  pre { background: #1a1a1a; padding: 1em; overflow-x: auto; border-radius: 4px; }
</style>
</head>
<body>
${innerHtml}
</body>
</html>`;
    try {
      const res = await fetch("/artifacts/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: firstLine, html }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const { id } = await res.json();
      appendSystemMsg(`Saved to Artifacts tab as <code>${id}</code>. Click the Artifacts tab to open it.`);
      // Trigger a refresh so it shows up immediately
      refreshArtifacts({ force: true });
    } catch (err) {
      appendSystemMsg(`Failed to save artifact: ${err.message}`);
    }
  },
  "/help": () => {
    const cmds = Object.keys(SLASH_COMMANDS).sort().join(", ");
    appendSystemMsg(`<strong>Slash commands:</strong> ${cmds}`);
    return Promise.resolve();
  },
};

function tryHandleSlash(text) {
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].toLowerCase();
  const handler = SLASH_COMMANDS[cmd];
  if (!handler) {
    appendSystemMsg(
      `Unknown command <code>${cmd}</code>. Try <code>/help</code>.`
    );
    return true;  // consumed (don't send to model)
  }
  promptInput.value = "";
  handler()
    .catch(err => console.error("[slash command error]", err))
    .finally(() => window.dispatchEvent(new CustomEvent("te:response-complete")));
  return true;
}

// ── Image attachments (drag/drop + paste) ───────────────────────────
//
// The user can drag-drop image files onto the composer, or paste an image
// from the clipboard, to send it to the model with their prompt for
// inference. Each pending image is stored as { name, mime, dataUrl, base64 }
// — dataUrl for the chip preview + chat render, base64 for the Ollama
// /api/chat payload (which expects raw base64, no data: prefix).
//
// Pending images live across multiple typed messages: the chips stay until
// either sent (cleared on submit) or removed via the chip's × button.
const pendingImages = [];   // { name, mime, dataUrl, base64 }
// Pending documents — Library PDFs the operator has dropped into chat. Each
// entry carries the doc_id returned by POST /document/prepare, which is the
// handle for /document/query during sendQuery. Cleared on submit just like
// pendingImages. Source URL preserved for the user-message provenance render.
const pendingDocuments = [];   // { name, title, doc_id, url, status }

function renderImageChips() {
  let bar = document.getElementById("image-chips");
  const hasAny = pendingImages.length > 0 || pendingDocuments.length > 0;
  if (!hasAny) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "image-chips";
    bar.className = "image-chips";
    composer.parentNode.insertBefore(bar, composer);
  }
  bar.innerHTML = "";
  pendingDocuments.forEach((doc, i) => {
    const chip = document.createElement("div");
    chip.className = "image-chip image-chip-doc";
    const status = doc.status === "ready"
      ? `<span class="image-chip-prov">${doc.chunks} chunks · ${doc.url.replace(/^https?:\/\/[^/]+/, "")}</span>`
      : doc.status === "indexing"
        ? `<span class="image-chip-prov">indexing…</span>`
        : `<span class="image-chip-prov image-chip-err">${doc.status}</span>`;
    chip.innerHTML = `
      <span class="image-chip-icon">📄</span>
      <div class="image-chip-meta">
        <span class="image-chip-name">${doc.title}</span>
        ${status}
      </div>
      <button type="button" class="image-chip-rm" aria-label="Remove">×</button>`;
    chip.querySelector(".image-chip-rm").addEventListener("click", () => {
      pendingDocuments.splice(i, 1);
      renderImageChips();
    });
    bar.appendChild(chip);
  });
  pendingImages.forEach((img, i) => {
    const chip = document.createElement("div");
    chip.className = "image-chip";
    // If the image came from a TE artifact URL, surface that as a small
    // "from /artifacts/…" line under the name. File drops just show name.
    const provHtml = img.sourceUrl
      ? `<span class="image-chip-prov">${img.sourceUrl.replace(/^https?:\/\/[^/]+/, "")}</span>`
      : "";
    chip.innerHTML = `
      <img src="${img.dataUrl}" alt="${img.name || ""}">
      <div class="image-chip-meta">
        <span class="image-chip-name">${img.name || "image"}</span>
        ${provHtml}
      </div>
      <button type="button" class="image-chip-rm" aria-label="Remove">×</button>`;
    chip.querySelector(".image-chip-rm").addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderImageChips();
    });
    bar.appendChild(chip);
  });
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error(`not an image: ${file.type}`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = String(dataUrl).split(",", 2)[1] || "";
      resolve({ name: file.name || "pasted-image", mime: file.type, dataUrl, base64 });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Fetch an image already served by serve.py (artifact URL) and convert it
// to the same { dataUrl, base64 } shape that file drops produce. The
// optional `meta` carries id/name/type/sourceUrl so the chat render and
// chip preview can show provenance ("from /artifacts/foo.png").
async function readImageUrl(url, meta = {}) {
  // data: URLs are already base64 — fetching them triggers a CSP violation.
  // Parse directly without a network round-trip.
  if (url.startsWith("data:")) {
    const [header, base64 = ""] = url.split(",", 2);
    const mime = (header.match(/data:([^;,]+)/) || [])[1] || "image/png";
    if (!mime.startsWith("image/")) throw new Error(`not an image: ${mime}`);
    return {
      name:      meta.name || "image",
      mime,
      dataUrl:   url,
      base64,
      sourceUrl: meta.sourceUrl || null,
    };
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const blob = await resp.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error(`not an image: ${blob.type || "unknown"}`);
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const base64 = String(dataUrl).split(",", 2)[1] || "";
  return {
    name:      meta.name || url.split("/").pop() || "image",
    mime:      blob.type,
    dataUrl,
    base64,
    sourceUrl: meta.sourceUrl || url,
    sourceId:  meta.id   || null,
    sourceType: meta.type || null,
  };
}

async function attachImageFiles(files) {
  for (const file of files) {
    try {
      const img = await readImageFile(file);
      pendingImages.push(img);
      // Also surface the file in the Artifacts tab. Use the data URL we
      // already produced for the chat composer — survives reload via the
      // artifact's own sessionStorage persistence.
      try {
        addUploadArtifact({
          name: file.name || img.name || "pasted-image",
          url:  img.dataUrl,
          mime: file.type || img.mime,
          size: file.size || 0,
          source: "drag-drop",
        });
      } catch (e) {
        console.warn("[image attach] artifact register failed:", e);
      }
    } catch (e) {
      console.warn("[image attach] skipped:", e.message);
    }
  }
  renderImageChips();
}

async function attachImageUrls(items) {
  for (const item of items) {
    try {
      const img = await readImageUrl(item.url, {
        id:        item.id,
        name:      item.name,
        type:      item.type,
        sourceUrl: item.url,
      });
      pendingImages.push(img);
    } catch (e) {
      console.warn("[image url attach] skipped:", e.message);
    }
  }
  renderImageChips();
}

// Attach a locally-selected file (from Browse or drag-drop). PDFs get
// uploaded to the server first so /document/prepare can extract real
// PDF text via PyPDF. Plain-text formats (txt/csv/json/md) are read
// client-side and injected as preText (cheap, no server hop).
async function attachLocalFileAsDoc(file) {
  const name  = file.name || "file";
  const lower = name.toLowerCase();
  const isPdf = file.type.includes("pdf") || /\.pdf$/i.test(lower);

  if (isPdf) {
    // Stage 1: upload to server. Server saves to session uploads dir.
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/upload-file", { method: "POST", body: fd });
    if (!r.ok) {
      console.warn("[doc attach] upload failed:", r.status);
      return;
    }
    const meta = await r.json();
    // Stage 2: route through normal document RAG path. /document/prepare
    // falls back to session uploads dir (see serve.py change).
    await attachDocuments([{ name: meta.id, title: name, url: meta.url }]);
    return;
  }

  // Text-ish formats: read client-side and inject directly as preText.
  if (/\.(txt|csv|json|md|log|tsv|xml|yml|yaml)$/i.test(lower) ||
      file.type.startsWith("text/") ||
      file.type === "application/json") {
    const text = await file.text().catch(() => "");
    if (!text) return;
    pendingDocuments.push({
      name, title: name,
      url:     URL.createObjectURL(file),
      status:  "ready",
      doc_id:  null,
      chunks:  1,
      preText: text.slice(0, 12000),
    });
    renderImageChips();
    return;
  }

  // Unknown binary type — refuse rather than send garbage to the model
  console.warn("[doc attach] unsupported file type:", file.type, name);
}

// Attach an artifact (HTML saved response or uploaded non-image file) as
// a pre-fetched context block. Fetches the content client-side, strips
// tags if HTML, and injects the text directly at send time — no server
// embedding needed. Shows an "indexing…" chip while fetching.
async function attachArtifactAsDoc(meta) {
  const label = meta.name || "artifact";

  // PDFs: route through document RAG (/document/prepare + chunking).
  // serve.py now falls back to the session upload dir so uploaded PDFs
  // work the same as Library PDFs — no binary-as-text garbage.
  const isPdf = (meta.mime || "").includes("pdf") || /\.pdf$/i.test(label);
  if (isPdf) {
    await attachDocuments([{ name: label, title: label, url: meta.url }]);
    return;
  }

  const placeholder = {
    name:    label,
    title:   label,
    url:     meta.url,
    status:  "indexing",
    doc_id:  null,
    chunks:  0,
    preText: null,
  };
  pendingDocuments.push(placeholder);
  renderImageChips();

  try {
    const resp = await fetch(meta.url);
    if (!resp.ok) throw new Error(`${resp.status}`);
    const text = await resp.text();
    // Strip HTML tags and collapse whitespace if this is an HTML artifact
    const isHtml = (meta.mime || "").includes("html") ||
                   meta.url.includes("/artifacts/") ||
                   /<html/i.test(text.slice(0, 500));
    let content = text;
    if (isHtml) {
      const tmp = document.createElement("div");
      tmp.innerHTML = text;
      // Remove script/style nodes before extracting text
      tmp.querySelectorAll("script,style,nav,header,footer").forEach(el => el.remove());
      content = (tmp.textContent || tmp.innerText || "").replace(/\s{3,}/g, "\n\n").trim();
    }
    placeholder.preText = content.slice(0, 12000); // cap at 12k chars
    placeholder.status  = "ready";
    placeholder.chunks  = 1;
  } catch (e) {
    placeholder.status = `load failed: ${e.message}`;
    console.warn("[artifact doc attach] failed:", e);
  }
  renderImageChips();
}

// Attach a Library PDF as a chat-with-document target. Posts to
// /document/prepare so the server can extract + chunk + embed the PDF;
// the resulting doc_id is what /document/query uses at send time. Shows
// an "indexing…" chip during prepare so the operator knows ICS forms
// will be ready in <1s but FEMA NIMS Doctrine takes ~30-60s.
async function attachDocuments(items) {
  for (const item of items) {
    const placeholder = {
      name:   item.name,
      title:  item.title || item.name,
      url:    item.url,
      status: "indexing",
      doc_id: null,
      chunks: 0,
    };
    pendingDocuments.push(placeholder);
    renderImageChips();
    try {
      const resp = await fetch("/document/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: item.name }),
      });
      if (!resp.ok) {
        const txt = await resp.text();
        placeholder.status = `index failed: ${resp.status}`;
        console.warn("[document prepare] failed:", txt);
        renderImageChips();
        continue;
      }
      const j = await resp.json();
      placeholder.status = "ready";
      placeholder.doc_id = j.doc_id;
      placeholder.chunks = j.chunks || 0;
      placeholder.title  = j.title || placeholder.title;
      renderImageChips();
      // Remember this doc was indexed so the Library tab can show a
      // "ready" badge on subsequent reloads (server cache is keyed off
      // sha so re-prep is also instant — this is purely UI memory).
      persist.saveDocEntry({
        name:    placeholder.name,
        title:   placeholder.title,
        doc_id:  placeholder.doc_id,
        chunks:  placeholder.chunks,
        prepared_at: Date.now(),
      });
    } catch (e) {
      placeholder.status = `error: ${e.message}`;
      renderImageChips();
    }
  }
}

// Drag & drop is scoped to the composer (the "Ask a NIMS / ICS question…"
// row) so the operator's dragging only highlights the actual drop target,
// not the whole page. Outside that row, drags fall through to default
// browser behavior (no overlay, no surprise capture).
//
// dragenter/dragleave bookkeeping uses a counter because dragleave fires
// for every child the cursor crosses (input, buttons) and we don't want
// the highlight to flicker as the cursor moves between them.
let _dragDepth = 0;
function setDropTarget(active) {
  composer.classList.toggle("drop-target", active);
}

// Three drag origins are accepted:
//   1. Files (Finder, etc.)        → dataTransfer.types includes "Files"
//   2. TE artifacts (panel thumbs) → custom MIME "application/x-te-artifact"
//   3. Generic URLs (other tabs)   → "text/uri-list" pointing at /artifacts/
function dragHasImagePayload(dataTransfer) {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  return types.includes("Files") ||
         types.includes("application/x-te-artifact") ||
         types.includes("application/x-te-document") ||
         types.includes("text/uri-list");
}

// Activate the composer's drop-target highlight as soon as a draggable
// artifact starts being dragged from anywhere on the page (and clear it
// when the drag ends, regardless of where it lands or if it's cancelled).
// This way the operator sees "drop here" advertised the moment they grab
// a thumb, rather than only after they cross into the input row. Files
// dragged in from outside the page can't be detected pre-drop, so for
// those we fall back to the normal dragenter trigger below.
document.addEventListener("dragstart", (e) => {
  const types = Array.from(e.dataTransfer?.types || []);
  if (types.includes("application/x-te-artifact") ||
      types.includes("application/x-te-document")) {
    setDropTarget(true);
  }
});
document.addEventListener("dragend", () => {
  _dragDepth = 0;
  setDropTarget(false);
});

composer.addEventListener("dragenter", (e) => {
  if (!dragHasImagePayload(e.dataTransfer)) return;
  e.preventDefault();
  _dragDepth++;
  setDropTarget(true);
});
composer.addEventListener("dragleave", (e) => {
  if (!e.dataTransfer) return;
  _dragDepth = Math.max(0, _dragDepth - 1);
  if (_dragDepth === 0) setDropTarget(false);
});
composer.addEventListener("dragover", (e) => {
  if (dragHasImagePayload(e.dataTransfer)) {
    e.preventDefault();   // required to allow drop
  }
});
composer.addEventListener("drop", async (e) => {
  if (!e.dataTransfer) return;
  if (!dragHasImagePayload(e.dataTransfer)) return;
  e.preventDefault();
  _dragDepth = 0;
  setDropTarget(false);

  // Order: prefer the typed metadata (document, then artifact), then file
  // drops, then plain URLs. Multiple sources rarely co-occur but we accept
  // whichever is set.
  const docJson = e.dataTransfer.getData("application/x-te-document");
  if (docJson) {
    try {
      const meta = JSON.parse(docJson);
      await attachDocuments([meta]);
      return;
    } catch (err) {
      console.warn("[drop] bad document metadata:", err);
    }
  }
  const artifactJson = e.dataTransfer.getData("application/x-te-artifact");
  if (artifactJson) {
    try {
      const meta = JSON.parse(artifactJson);
      const isImg = (meta.mime || "").startsWith("image/") ||
                    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(meta.name || "");
      if (isImg) {
        await attachImageUrls([meta]);
      } else {
        await attachArtifactAsDoc(meta);
      }
      return;
    } catch (err) {
      console.warn("[drop] bad artifact metadata:", err);
    }
  }

  const allFiles = Array.from(e.dataTransfer.files || []);
  if (allFiles.length) {
    const images = allFiles.filter(
      (f) => f.type.startsWith("image/") || /\.(heic|heif|avif)$/i.test(f.name)
    );
    const docs = allFiles.filter((f) => !images.includes(f));
    if (images.length) await attachImageFiles(images);
    for (const d of docs) await attachLocalFileAsDoc(d);
    if (allFiles.length) return;
  }

  const uris = (e.dataTransfer.getData("text/uri-list") || "")
    .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  // Only accept same-origin /artifacts/ URLs — don't let arbitrary cross-
  // origin drags trigger CORS-laden fetches we'd silently fail at.
  const artifactUrls = uris
    .map((u) => { try { return new URL(u, window.location.href); } catch { return null; } })
    .filter((u) => u && u.origin === window.location.origin && u.pathname.startsWith("/artifacts/"))
    .map((u) => ({ url: u.href, name: decodeURIComponent(u.pathname.split("/").pop() || "") }));
  if (artifactUrls.length) {
    await attachImageUrls(artifactUrls);
  }
});

// Browse button in Upload tab dispatches this instead of a synthetic DragEvent
// (which doesn't reliably propagate files cross-browser).
window.addEventListener("te:attach-files", async (e) => {
  const files = Array.from(e.detail?.files || []);
  const images = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif|avif)$/i.test(f.name));
  const docs   = files.filter((f) => !images.includes(f));
  if (images.length) await attachImageFiles(images);
  for (const d of docs) {
    await attachLocalFileAsDoc(d);
  }
});

// Paste from clipboard — Cmd/Ctrl+V with an image on the system clipboard
// drops it into pending images. Same code path as drag/drop.
window.addEventListener("paste", async (e) => {
  if (!e.clipboardData) return;
  const files = Array.from(e.clipboardData.files || []).filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  await attachImageFiles(files);
});

composer.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const q = promptInput.value.trim();
  // Allow image- or document-only queries (e.g. "what's this?" implied) —
  // strip the slash check first since slash commands are text-only.
  if (q && tryHandleSlash(q)) return;
  if (q && handleVoiceSkill(q)) { promptInput.value = ""; return; }
  if (!q && pendingImages.length === 0 && pendingDocuments.length === 0) return;
  // Drain pending attachments into per-send snapshots so the arrays can
  // be mutated safely below.
  const imgs = pendingImages.splice(0, pendingImages.length);
  const docs = pendingDocuments.splice(0, pendingDocuments.length);
  renderImageChips();
  sendQuery(q, imgs, docs);
});

// ── Map: initMap deferred until /demo ─────────────────────────────────
function bootMap() {
  const scenario = activeScenario();
  try { localStorage.removeItem("te-fob-map-state"); } catch (_) {}
  initMap(scenario);
  const placeholder = $("map-placeholder");
  if (placeholder) { placeholder.hidden = true; placeholder.style.display = "none"; }
  // Leaflet needs to recalculate container size after visibility change
  setTimeout(() => {
    const mapInstance = getMap();
    if (mapInstance && mapInstance.invalidateSize) {
      mapInstance.invalidateSize();
    }
  }, 50);
  const mapMeta = $("map-meta");
  if (mapMeta) mapMeta.textContent = `${scenario.name} · ${scenario.markers.length} markers`;
}
const tilesBtn     = $("map-tiles");
const trackBtn     = $("map-track");
const buildingsBtn = $("map-buildings");
const mapLegend    = $("map-legend");

function makeOverlayToggle(btn, toggleFn, label) {
  if (!btn) return;
  btn.addEventListener("click", () => {
    const on = toggleFn();
    btn.classList.toggle("active", on);
    btn.textContent = on ? `🔴 ${label}` : `⬛ ${label}`;
    if (label === "Buildings" && mapLegend) mapLegend.hidden = !on;
  });
}

makeOverlayToggle(tilesBtn,     toggleTileLayer,        "Map");
makeOverlayToggle(trackBtn,     toggleTrackOverlay,     "Track");
makeOverlayToggle(buildingsBtn, toggleBuildingsOverlay, "Buildings");

// ── Boot the ICS form panel ─────────────────────────────────────────
initFormsPanel();

// ── Boot the VPO chain panel ────────────────────────────────────────
initChainPanel();

// ── Boot the Upload panel ────────────────────────────────────────────
initUploadPanel();

// ── Tab switcher (ICS Form ↔ VPO Chain ↔ Artifacts) ─────────────────
//
// Each tab has a hidden meta element (form-meta, chain-meta, artifacts-meta)
// whose textContent is mirrored into the panel's tab-meta-display chip when
// that tab is active. Adding a new tab = add it to TAB_META below + a pane
// in index.html with id="tab-<key>" + a hidden-meta child id="<key>-meta".
const TAB_META = {
  form:      "form-meta",
  chain:     "chain-meta",
  artifacts: "artifacts-meta",
  library:   "library-meta",
  data:      "data-meta",
};

function initTabs() {
  const tabs    = document.querySelectorAll(".tab");
  const panes   = document.querySelectorAll(".tab-pane");
  const display = $("tab-meta-display");

  function syncMeta() {
    if (!display) return;
    const active = document.querySelector(".tab.active")?.dataset.tab;
    const id = TAB_META[active];
    display.textContent = id ? ($(id)?.textContent || "") : "";
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      panes.forEach(p => p.classList.toggle("active", p.id === `tab-${target}`));
      syncMeta();
    });
  });

  // Watch for meta updates from each tab module
  Object.values(TAB_META).forEach((id) => {
    const el = $(id);
    if (!el) return;
    new MutationObserver(syncMeta).observe(el, { childList: true, characterData: true, subtree: true });
  });

  syncMeta();
}
initTabs();

// ── Boot voice (Web Speech API for both directions for now) ─────────
// Phase 2: replace TTS with bundled Piper-Wasm + en_GB-alan voice file
// for full-offline operation. STT stays on Web Speech (browser-native).
// ── Voice skill router ───────────────────────────────────────────────
// Intercepts recognised speech before it reaches Severian. Returns true
// if the utterance matched a local skill (map layer toggle, etc.) so the
// caller can skip sendQuery. Patterns are intentionally loose — natural
// speech rarely hits exact phrases.
function handleVoiceSkill(text) {
  const t = text.toLowerCase();

  const matchesTrack = /\b(tornado|damage|ef.?5|tornado\s+track|track)\b/.test(t) &&
    /\b(show|display|turn\s+on|toggle|load|see|open|add|enable|view)\b/.test(t) ||
    /\b(show\s+(me\s+)?(the\s+)?(tornado|damage)\s+track)\b/.test(t) ||
    /\btoggle\s+track\b/.test(t);

  const matchesBuildings = /\b(building|buildings|structure|structures|damage\s+layer|building\s+damage)\b/.test(t) &&
    /\b(show|display|turn\s+on|toggle|load|see|open|add|enable|view)\b/.test(t) ||
    /\b(show\s+(me\s+)?(the\s+)?(building|damage|structural))\b/.test(t) ||
    /\btoggle\s+buildings\b/.test(t);

  if (matchesTrack) {
    SLASH_COMMANDS["/track"]();
    return true;
  }
  if (matchesBuildings) {
    SLASH_COMMANDS["/buildings"]();
    return true;
  }
  return false;
}

initVoice({
  onTranscript: (text) => {
    promptInput.value = text;
    if (!text) return;
    if (handleVoiceSkill(text)) {
      promptInput.value = "";   // clear input — skill handled it, no need to send
      return;
    }
    sendQuery(text);
  },
});

// ── Boot the LLM (Ollama-on-localhost — see STRATEGY.md) ────────────
initEngine();

// ── Boot demo scenario if ?autoload=demo (runs regardless of Ollama) ─
initDemo();

// ── Demo Walkthrough button — wired unconditionally ─────────────────
(function wireTourButton() {
  const btn = document.getElementById("tour-btn");
  if (!btn) return;

  function setTourBtnState(active) {
    btn.disabled = active;
    btn.style.opacity = active ? "0.45" : "";
    btn.title = active ? "Tour in progress — skip or finish to restart" : "Start a guided walkthrough of key features";
  }

  btn.addEventListener("click", () => {
    resetTour();
    startTour({ promptInput, composer });
    setTourBtnState(true);
    chatArea?.scrollIntoView({ behavior: "smooth" });
  });

  // Advance tour when the LLM response fully completes.
  // te:response-complete fires from the sendQuery() finally block — reliable
  // regardless of VPO signing success. Guard with _tourQueryPending so only
  // queries sent during an active tour step trigger advancement.
  let _tourQueryPending = false;
  document.getElementById("composer")?.addEventListener("submit", () => {
    if (isTourActive()) _tourQueryPending = true;
  }, { capture: true });

  window.addEventListener("te:response-complete", () => {
    if (!isTourActive()) { setTourBtnState(false); return; }
    if (!_tourQueryPending) return;
    _tourQueryPending = false;
    advanceTour();
  });

  // Re-enable the button whenever the tour ends (skip or complete).
  window.addEventListener("te:tour-ended", () => setTourBtnState(false));
}());

// ── Mobile bottom navigation ─────────────────────────────────────────
(function initMobileNav() {
  const cop = document.querySelector("main.cop");
  if (!cop) return;

  // Default active tab
  cop.classList.add("mobile-tab-chat");

  document.querySelectorAll(".mobile-nav-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.mobileTab;
      document.querySelectorAll(".mobile-nav-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      cop.className = "cop mobile-tab-" + tab;
      // When switching to map tab, tell Leaflet to recalculate size
      if (tab === "map") {
        setTimeout(() => {
          const mapInst = getMap?.();
          if (mapInst?.invalidateSize) mapInst.invalidateSize();
        }, 50);
      }
      // When switching to tabs, refresh the chain panel
      if (tab === "tabs") {
        document.querySelector('.tab[data-tab="chain"]')?.dispatchEvent(new Event("click"));
      }
    });
  });

  // When a chat response arrives on mobile, switch back to chat if not already there
  window.addEventListener("te:response-complete", () => {
    if (window.innerWidth <= 700 && !cop.classList.contains("mobile-tab-chat")) {
      document.querySelector('.mobile-nav-btn[data-mobile-tab="chat"]')?.click();
    }
  });
}());

// ── Welcome modal — shown once per session on first load ──────────────
(function showWelcomeModal() {
  if (sessionStorage.getItem("te-welcome-seen")) return;
  sessionStorage.setItem("te-welcome-seen", "1");

  const overlay = document.createElement("div");
  overlay.id = "te-welcome-overlay";
  overlay.innerHTML = `
    <div class="te-welcome-box" role="dialog" aria-modal="true" aria-labelledby="te-welcome-title">
      <div class="te-welcome-logo">
        <span class="brand-t">T</span><span class="brand-e">E</span><span class="brand-rest"> NIMS</span>
      </div>
      <h2 class="te-welcome-title" id="te-welcome-title">Welcome to the TE NIMS Demo</h2>
      <p class="te-welcome-body">
        TE NIMS is an agentic agent harness running a fine-tuned Gemma 4 LLM designed
        to support first responder Incident Command (IC) with high-quality,
        doctrine-grounded decision support and agentic tooling. TE NIMS is an
        open-source project of <strong>Terminus Est AI</strong> and is capable of fully
        running at the edge on a thumb drive <em>(token throughput governed by computer specs)</em>.
      </p>
      <p class="te-welcome-body">
        This demo loads non-proprietary data for Oklahoma City and a simulated scenario
        based on the Moore 2013 tornado. TE NIMS is capable of providing support across
        a wide range of disasters — hurricanes, floods, earthquakes, biological and
        nuclear hazards, and more.
      </p>
      <p class="te-welcome-body">
        It is trained on over 50,000 doctrinal elements covering the
        <strong>National Incident Management System (NIMS)</strong> and the
        <strong>Incident Command System (ICS)</strong>.
      </p>
      <div class="te-welcome-actions">
        <button class="te-welcome-cta te-welcome-tour" autofocus>▶ Demo Walkthrough</button>
        <button class="te-welcome-cta te-welcome-skip">Skip Demo</button>
      </div>
    </div>`;

  const close = () => overlay.remove();

  overlay.querySelector(".te-welcome-tour").addEventListener("click", () => {
    close();
    // Fire tour after a tick so the modal is gone before the tour card renders
    setTimeout(() => {
      const tourBtnEl = document.getElementById("tour-btn");
      if (tourBtnEl) tourBtnEl.click();
    }, 120);
  });

  overlay.querySelector(".te-welcome-skip").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  });

  document.body.appendChild(overlay);
  overlay.querySelector(".te-welcome-cta").focus();
}());
