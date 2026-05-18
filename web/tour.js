// TE NIMS · FOB — Guided demo tour (floating modal)
//
// Shows a floating bottom-right modal with suggested queries. Each step
// updates the modal in place. State lives in sessionStorage.

const STORAGE_KEY = "te-tour-step";
const DONE = "done";

const STEPS = [
  {
    n: 1,
    body: "You are the Incident Commander arriving at the Moore EF5 tornado. Start by asking TE NIMS for situational awareness.",
    query: "I'm Chief Martinez, Moore Fire Department. I am the Incident Commander, just arriving on scene of an EF5 tornado. What's the situation?",
  },
  {
    n: 2,
    body: "Hands-free operation is critical for a busy Incident Commander. Pressing the Speaker button in the bottom right will enter voice mode — TE NIMS will speak its responses aloud. Press it again to turn it off.",
    informational: true,
    action: () => {
      const ttsBtn = document.getElementById("tts");
      if (ttsBtn && !ttsBtn.classList.contains("active")) ttsBtn.click();
    },
  },
  {
    n: 3,
    body: "TE NIMS grounds every recommendation in NIMS doctrine. Ask about your ICS priorities.",
    query: "What are my immediate ICS priorities for life safety in the first operational period?",
  },
  {
    n: 4,
    body: "<span class='te-tour-note'>🔊 Note — You should hear the voice agent in a few seconds. To turn it off click the speaker icon at the bottom right.</span>TE NIMS can generate the data for ICS forms on demand. In the live version these forms can be saved live to the ICS Form Directory.",
    query: "Generate an initial ICS-201 Incident Briefing for this incident.",
    preSubmit: () => {
      const ttsBtn = document.getElementById("tts");
      if (ttsBtn && ttsBtn.classList.contains("active")) ttsBtn.click();
    },
  },
  {
    n: 5,
    body: "The Library tab contains all major NIMS and ICS data and training materials. Items here are available via Retrieval Augmented Search (RAG) as well.<br><br>Filter or open any document from the Library. Library contents are available to the AI via Retrieval Augmented Search.",
    query: "search doctrine for 'what are search team roles.'",
    tab: "library",
  },
  {
    n: 6,
    body: "TE NIMS let the Incident Commander know he needed to establish his organizational structure. Chief Martinez has drawn out his org chart on a butcher board. TE NIMS allows him to use the upload QR code to take a picture of it and have it analyzed and redrawn to doctrine then stored as an artifact. Many items in a command center are still done by hand for speed and ease of use, but TE NIMS allows them to be turned into AI available artifacts using Gemma 4's multi-modal vision capabilities.",
    informational: true,
    tab: "upload",
  },
  {
    n: 7,
    body: "Drag and drop the image into the chat area for analysis.",
    query: "redraw this in Ascii.",
    tab: "artifacts",
    waitForImage: true,
  },
  {
    n: 8,
    body: "TE NIMS can use Gemma's multimodal capabilities to leverage its doctrinal knowledge.",
    query: "Create a doctrinally correct version of the diagram.",
  },
  {
    n: 9,
    body: "TE NIMS can save any chat response as a standalone HTML artifact. Run /save to capture the previous answer — it appears in the Artifacts tab.",
    query: "/save",
    tab: "artifacts",
  },
  {
    n: 10,
    body: "<span style='opacity:.5;font-size:10px;display:block;margin-bottom:8px'>Click on the new TE NIMS Doc to see the saved org chart.</span>TE NIMS is fully geo-aware. Future work will include TAK and WebEOC cross-compatibility. The Track button on the map shows a simulated damage track, and the Buildings button shows building damage. Both were created with real-time tools by TE NIMS Labs that will be integrated into future versions — allowing First Responders to instantly estimate damage by building type.",
    query: "What building types are most at risk in the Moore tornado damage corridor?",
  },
  {
    n: 11,
    body: "Get operationally specific. Ask for resource typing tied to a real location on the map.",
    query: "Recommend resource typing for urban search-and-rescue at Plaza Towers Elementary.",
  },
  {
    n: 12,
    body: "Geo-spatial awareness is critical to disaster planning. TE NIMS can display critical locations it is tracking for an incident in real time.",
    informational: true,
  },
  {
    n: 13,
    body: "Now Chief Martinez needs to know where the closest Search and Rescue element is located.",
    query: "What is the closest staging area to the Plaza Elementary?",
  },
  {
    n: 14,
    body: "Now the Incident Commander needs to know their location so he can plan the operation.",
    query: "Show me Moore Fire Station 1.",
  },
  {
    n: 15,
    body: "TE NIMS uses a custom data retrieval protocol over 114 federal databases. For offline use like this demo, it allows the loading of Gold parquets bundled within the docker image for specific geographies like Oklahoma City. This demo contains 2,463 records of custom data as shown.",
    informational: true,
    tab: "data",
  },
  {
    n: 16,
    body: "Thank you for checking out TE NIMS. We built it out of need after 40 years of disaster management — we know that AI will save lives!",
    informational: true,
    dedication: "This project is dedicated to the brave first responders we have had the honor to work with over the decades.",
    buttonLabel: "End Tutorial",
    endTour: true,
  },
];

const TOTAL = STEPS.length;

// ── Chime ─────────────────────────────────────────────────────────────
// Plays a soft two-note ascending chime using Web Audio API.
// Called each time a new tour card appears.
function _playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [
      { freq: 880, start: 0,    dur: 0.18 },   // A5 — soft tap
      { freq: 1174.66, start: 0.12, dur: 0.28 }, // D6 — resolve up
    ];
    notes.forEach(({ freq, start, dur }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    });
    // Close context after sound finishes to free resources
    setTimeout(() => ctx.close(), 600);
  } catch { /* AudioContext blocked — silently skip */ }
}

let _promptInput = null;
let _composer    = null;
let _modal       = null;  // the single persistent floating modal element

function _state()      { return sessionStorage.getItem(STORAGE_KEY) || "0"; }
function _setState(v)  { try { sessionStorage.setItem(STORAGE_KEY, String(v)); } catch { /**/ } }

export function isTourActive() {
  const s = _state();
  if (s === DONE) return false;
  return parseInt(s, 10) >= 0 && parseInt(s, 10) <= TOTAL;
}

// ── Modal DOM ─────────────────────────────────────────────────────────

function _makeDraggable(el) {
  let ox = 0, oy = 0, startX = 0, startY = 0, dragging = false;

  el.addEventListener("mousedown", (e) => {
    // Only drag from the header row, not from buttons/links/dots
    if (e.target.closest("button, a, .te-tour-dot")) return;
    dragging = true;
    // Switch from CSS anchoring to top/left so position is stable while dragging
    const rect = el.getBoundingClientRect();
    el.style.bottom    = "auto";
    el.style.right     = "auto";
    el.style.transform = "none";   // clear translateX(-50%) centering
    el.style.top       = rect.top  + "px";
    el.style.left      = rect.left + "px";  // getBoundingClientRect already accounts for the translation
    startX = e.clientX;
    startY = e.clientY;
    ox = rect.left;
    oy = rect.top;
    el.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    el.style.left = Math.max(0, ox + e.clientX - startX) + "px";
    el.style.top  = Math.max(0, oy + e.clientY - startY) + "px";
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = "grab";
  });

  el.style.cursor = "grab";
}

function _getOrCreateModal() {
  if (_modal && document.body.contains(_modal)) return _modal;
  _modal = document.createElement("div");
  _modal.id = "te-tour-float";
  _modal.className = "te-tour-float";
  document.body.appendChild(_modal);
  _makeDraggable(_modal);
  return _modal;
}

function _removeModal() {
  if (_modal) { _modal.remove(); _modal = null; }
}

function _setModalContent(html) {
  const m = _getOrCreateModal();
  // Clean up any image-wait listener from the previous step
  if (typeof m._tourImageCleanup === "function") {
    m._tourImageCleanup();
    delete m._tourImageCleanup;
  }
  m.innerHTML = html;
  // Animate in
  m.style.opacity = "0";
  m.style.transform = "translateY(12px)";
  requestAnimationFrame(() => {
    m.style.transition = "opacity 0.22s ease, transform 0.22s ease";
    m.style.opacity = "1";
    m.style.transform = "translateY(0)";
  });
  return m;
}

// ── Step rendering ────────────────────────────────────────────────────

function _dots(current) {
  return STEPS.map((_, i) =>
    `<span class="te-tour-dot${i === current ? " active" : ""}" data-step="${i}" title="Go to step ${i + 1}"></span>`
  ).join("");
}

function _wireDotNavigation(m) {
  m.querySelectorAll(".te-tour-dot[data-step]").forEach(dot => {
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(dot.dataset.step, 10);
      if (idx >= 0 && idx < STEPS.length) {
        _setState(idx);
        _renderStep(STEPS[idx]);
      }
    });
  });
}

function _renderStep(step) {
  if (!_promptInput || !_composer) return;
  _playChime();

  // Optionally switch to a specific tab when this step opens
  if (step.tab) {
    const tabBtn = document.querySelector(`.tab[data-tab="${step.tab}"]`);
    if (tabBtn) tabBtn.click();
  }
  // Optionally run a DOM action when this step opens (e.g. click a button)
  if (step.action) {
    try { step.action(); } catch (e) { console.warn("[tour] step action failed:", e); }
  }

  const queryHtml = step.informational
    ? ""
    : `<div class="te-tour-float-query">"${step.query.replace(/"/g, '&quot;')}"</div>`;
  const dedicationHtml = step.dedication
    ? `<div class="te-tour-dedication">${step.dedication}</div>`
    : "";
  const actionLabel = step.buttonLabel || (step.informational ? "Next Step →" : "→ Try this query");
  // waitForImage steps start disabled until the user drags an image in
  const needsImage = !!step.waitForImage;

  const m = _setModalContent(`
    <div class="te-tour-float-header">
      <div class="te-tour-dots">${_dots(step.n - 1)}</div>
      <span class="te-tour-badge">Step ${step.n} / ${TOTAL}</span>
      <button class="te-tour-close" type="button" aria-label="Skip tour">✕</button>
    </div>
    <div class="te-tour-float-body">${step.body}</div>
    ${queryHtml}
    ${dedicationHtml}
    <div class="te-tour-float-actions">
      <button class="te-tour-try" type="button"
        ${needsImage ? 'disabled title="Drag an image into the chat first"' : ""}>
        ${needsImage ? "📎 Attach image first…" : actionLabel}
      </button>
      ${step.endTour ? "" : `<a class="te-tour-skip" href="#">Skip tour</a>`}
    </div>
  `);

  // If this step waits for an image, wire up the enable/disable listener
  if (needsImage) {
    const tryBtn = m.querySelector(".te-tour-try");
    const _onImages = (e) => {
      const hasImage = (e.detail?.count || 0) > 0;
      tryBtn.disabled = !hasImage;
      tryBtn.textContent = hasImage ? actionLabel : "📎 Attach image first…";
    };
    window.addEventListener("te:pending-images-changed", _onImages);
    // Clean up listener when the modal is replaced or dismissed
    const _cleanup = () => window.removeEventListener("te:pending-images-changed", _onImages);
    m._tourImageCleanup = _cleanup;
  }

  m.querySelector(".te-tour-try").addEventListener("click", () => {
    if (step.endTour) {
      _dismiss();
      return;
    }
    if (step.informational) {
      advanceTour();
      return;
    }
    if (step.preSubmit) { try { step.preSubmit(); } catch (e) { console.warn("[tour] preSubmit failed:", e); } }
    _promptInput.value = step.query;
    _composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // Grey out the button so it's clear the query was sent
    m.querySelector(".te-tour-try").disabled = true;
    m.querySelector(".te-tour-try").textContent = "Sent ✓";
  });

  m.querySelector(".te-tour-close").addEventListener("click", () => _dismiss());
  m.querySelector(".te-tour-skip")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    _dismiss();
  });
  _wireDotNavigation(m);
}

function _renderFinalCard() {
  _playChime();
  _setModalContent(`
    <div class="te-tour-float-header">
      <div class="te-tour-dots">${STEPS.map(() => '<span class="te-tour-dot active"></span>').join("")}</div>
      <span class="te-tour-badge" style="color:#4caf50">✓ Tour Complete</span>
      <button class="te-tour-close" type="button" aria-label="Close">✕</button>
    </div>
    <div class="te-tour-float-body">
      Every chat message is documented with a demo provenance chain (demo signing key — illustrative) to demonstrate auditability.
      Click <strong>▸ VPO Chain</strong> to see the entire chain. This is critical for documentation
      and auditability of disaster management incidents and can be used to recreate or document
      entire operational turns.
    </div>
    <div class="te-tour-float-actions">
      <button class="te-tour-try te-tour-done" type="button">Got it</button>
    </div>
  `);
  _setState(DONE);
  window.dispatchEvent(new CustomEvent("te:tour-ended"));
  _modal.querySelector(".te-tour-close")?.addEventListener("click", _removeModal);
  _modal.querySelector(".te-tour-done")?.addEventListener("click", _removeModal);
}

function _dismiss() {
  _setState(DONE);
  _removeModal();
  window.dispatchEvent(new CustomEvent("te:tour-ended"));
}

// ── Public API ────────────────────────────────────────────────────────

export function startTour(opts) {
  _promptInput = opts?.promptInput || null;
  _composer    = opts?.composer    || null;

  if (!_promptInput || !_composer) {
    console.warn("[tour] missing promptInput/composer, cannot start");
    return;
  }

  const s = _state();
  if (s === DONE) return;

  const stepIdx = parseInt(s, 10) || 0;
  if (stepIdx >= TOTAL) {
    _renderFinalCard();
    return;
  }
  _setState(stepIdx);
  _renderStep(STEPS[stepIdx]);
}

export function advanceTour() {
  if (!isTourActive()) return;
  const stepIdx = parseInt(_state(), 10) || 0;
  const next = stepIdx + 1;
  if (next >= TOTAL) {
    _setState(TOTAL);
    setTimeout(() => _renderFinalCard(), 600);
    return;
  }
  _setState(next);
  setTimeout(() => {
    if (isTourActive()) _renderStep(STEPS[next]);
  }, 800);
}

export function resetTour() {
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /**/ }
  _removeModal();
}
