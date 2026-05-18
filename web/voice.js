// TE NIMS · FOB — voice in/out
//
// IN:  Web Speech API (SpeechRecognition) — push-to-talk, browser-native,
//      no model download. Chrome ships en-US recognition; the browser may
//      send audio to Google for transcription depending on settings — note
//      this for FOB offline use (Web Speech is NOT fully offline by default).
//
// OUT: SpeechSynthesis (Web Speech) for the POC — also browser-native.
//      Phase 2: bundle Piper-Wasm with the en_GB-alan-medium voice file
//      so TTS matches the CLI exactly and is fully offline. Implementation
//      stub left for the next pass.

let listening = false;
let recognition = null;
let ttsEnabled  = false;
let _audioCtx   = null;
let _resultTexts = new Map();
let _holdingPtt  = false;
let _stopRequested = false;
let _micStream = null;

function _normalizeTranscript(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function _composeTranscript() {
  return Array.from(_resultTexts.keys())
    .sort((a, b) => a - b)
    .map((k) => _resultTexts.get(k) || "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function _resetTranscriptState() {
  _resultTexts = new Map();
}

async function _ensureMicAccess() {
  if (!navigator.mediaDevices?.getUserMedia) return true;
  if (_micStream) return true;
  try {
    _micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return true;
  } catch (err) {
    console.warn("microphone access failed:", err);
    return false;
  }
}

function _releaseMicAccess() {
  if (!_micStream) return;
  for (const track of _micStream.getTracks()) {
    try { track.stop(); } catch {}
  }
  _micStream = null;
}

// Claim the macOS audio session so the OS routes headset media buttons
// (BlueParrott PTT, AirPods stem, etc.) to Chrome's MediaSession handlers
// instead of to Spotify / Apple Music / Siri. Must be called inside a user
// gesture (click/key) — AudioContext won't start otherwise.
function _claimAudioSession() {
  if (_audioCtx) return;
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // 1-second silent buffer, looping — keeps the audio context alive so
    // Chrome holds the "now playing" slot on macOS indefinitely.
    const buf = _audioCtx.createBuffer(1, _audioCtx.sampleRate, _audioCtx.sampleRate);
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    src.loop   = true;
    src.connect(_audioCtx.destination);
    src.start();
  } catch (e) { /* audio not available — MediaSession still set up below */ }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "Severian NIMS · PTT ready",
      artist: "Terminus Est AI",
    });
    navigator.mediaSession.playbackState = "paused";
  }
}

function makeRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = "en-US";
  // Use browser-native STT, but keep the session bounded to one active
  // press-to-talk utterance. We reassemble multiple result segments locally.
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 3;
  return r;
}

export function initVoice({ onStart, onPartial, onCommit, onAbort }) {
  const micBtn  = document.getElementById("mic");
  const ttsBtn  = document.getElementById("tts");

  // ── Mic / push-to-talk ─────────────────────────────────────────────
  recognition = makeRecognition();
  if (recognition && micBtn) {
    window.addEventListener("beforeunload", _releaseMicAccess);
    micBtn.disabled = false;
    micBtn.title = "Hold to speak";

    const _msState = (state) => {
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
    };

    const _setMicUi = (active) => {
      micBtn.classList.toggle("listening", active);
      micBtn.title = active
        ? "Listening… release to transcribe"
        : "Hold to speak";
    };

    const _emitPartial = () => {
      if (onPartial) onPartial(_composeTranscript());
    };

    const _commitTranscript = () => {
      const transcript = _composeTranscript();
      _resetTranscriptState();
      if (onCommit && transcript) onCommit(transcript);
    };

    const start = () => {
      if (listening) return;
      _claimAudioSession();
      _stopRequested = false;
      _resetTranscriptState();
      try {
        recognition.start();
        listening = true;
        _setMicUi(true);
        _msState("playing");
        if (onStart) onStart();
      } catch (e) { /* already started — ignore */ }
    };
    const stop = ({ commit = true } = {}) => {
      if (!listening) return;
      _stopRequested = commit;
      try { recognition.stop(); } catch {}
      listening = false;
      _setMicUi(false);
      _msState("paused");
    };

    const beginHold = async () => {
      _holdingPtt = true;
      const micReady = await _ensureMicAccess();
      if (!_holdingPtt) return;
      if (!micReady) {
        _holdingPtt = false;
        _setMicUi(false);
        if (onAbort) onAbort("microphone-unavailable");
        return;
      }
      start();
    };
    const endHold = () => {
      if (!_holdingPtt && !listening) return;
      _holdingPtt = false;
      stop({ commit: true });
    };

    // Claim audio session on first any user gesture so macOS routes the
    // BlueParrott button to Chrome before the operator ever touches the mic.
    const _firstGesture = () => { _claimAudioSession(); };
    document.addEventListener("click",   () => { _firstGesture(); void _ensureMicAccess(); }, { once: true });
    document.addEventListener("keydown", () => { _firstGesture(); void _ensureMicAccess(); }, { once: true });

    // True push-to-talk on the on-screen mic button.
    micBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      try { micBtn.setPointerCapture(e.pointerId); } catch {}
      void beginHold();
    });
    micBtn.addEventListener("pointerup", endHold);
    micBtn.addEventListener("pointercancel", endHold);
    micBtn.addEventListener("lostpointercapture", endHold);
    micBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("pointerup", () => {
      if (_holdingPtt) endHold();
    });
    window.addEventListener("blur", () => {
      if (listening) stop({ commit: true });
    });

    // BlueParrott B450-XT side button — three layers so it works regardless
    // of Karabiner install or browser focus state:
    //
    // 1. Karabiner → F19 keydown (works when browser window is focused)
    // 2. MediaPlayPause keydown fallback (same, no Karabiner required)
    // 3. MediaSession API — OS routes the headset button to Chrome's active
    //    media session, fires even when the window is NOT focused. This is
    //    the most reliable path for the BlueParrott during the demo.
    window.addEventListener("keydown", (e) => {
      if (e.code === "F19" || e.code === "MediaPlayPause") {
        if (e.repeat) return;
        e.preventDefault();
        void beginHold();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "F19" || e.code === "MediaPlayPause") {
        e.preventDefault();
        endHold();
      }
    });

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play",  () => { if (!listening) beginHold(); });
      navigator.mediaSession.setActionHandler("pause", () => { if (listening)  endHold(); });
    }

    recognition.addEventListener("result", (ev) => {
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i];
        const transcript = _normalizeTranscript(res[0]?.transcript || "");
        if (transcript) {
          _resultTexts.set(i, transcript);
        } else if (!res.isFinal) {
          _resultTexts.delete(i);
        }
      }
      _emitPartial();
    });
    recognition.addEventListener("end", () => {
      if (_stopRequested) {
        _stopRequested = false;
        _commitTranscript();
        _setMicUi(false);
        return;
      }
      // Browser stopped recognition unexpectedly mid-PTT — resume while held.
      if (_holdingPtt) {
        listening = false;
        try {
          recognition.start();
          listening = true;
          _setMicUi(true);
        } catch (e) { /* ignore */ }
      } else {
        listening = false;
        _setMicUi(false);
      }
    });
    recognition.addEventListener("error", (ev) => {
      if (ev.error === "no-speech") return; // expected in continuous mode — just keep going
      listening = false;
      _holdingPtt = false;
      _setMicUi(false);
      if (onAbort) onAbort(ev.error || "recognition-error");
      console.warn("speech recognition error:", ev.error);
    });
  } else if (micBtn) {
    micBtn.title = "Speech recognition not supported in this browser";
    micBtn.disabled = true;
  }

  // ── TTS toggle ─────────────────────────────────────────────────────
  // Always available — we use serve.py's /tts endpoint (Piper en_GB-alan-medium,
  // same voice as the CLI). Browser-native speechSynthesis is NOT used —
  // banned per the lab's brand+offline rules.
  if (ttsBtn) {
    ttsBtn.disabled = false;
    ttsBtn.title    = "Click to enable spoken responses";
    // Restore prior TTS toggle state from localStorage. Restoring as ON
    // does NOT auto-speak the welcome line — that would startle the
    // operator on every reload. Just visual state until they speak again.
    try {
      const saved = JSON.parse(localStorage.getItem("te-fob-tts-enabled") || "false");
      if (saved) {
        ttsEnabled = true;
        ttsBtn.classList.add("active");
        ttsBtn.title = "TTS on (click to mute)";
      }
    } catch { /* ignore */ }

    ttsBtn.addEventListener("click", () => {
      ttsEnabled = !ttsEnabled;
      ttsBtn.classList.toggle("active", ttsEnabled);
      ttsBtn.title = ttsEnabled ? "TTS on (click to mute)" : "Click to enable spoken responses";
      try { localStorage.setItem("te-fob-tts-enabled", JSON.stringify(ttsEnabled)); }
      catch { /* ignore */ }
      if (ttsEnabled) {
        speak("Voice on. Tee Eee NIMS listening.");
      } else {
        // Hard-cut any in-flight audio so toggling mute is instant.
        // Without this, a long response continues playing through the
        // pre-buffered audio element until it ends naturally.
        stopSpeaking();
      }
    });
  }
}

function stripForSpeech(text) {
  return String(text)
    .replace(/`+/g, "")
    .replace(/[\*_]+/g, "")
    .replace(/^#+\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\bTE\s+NIMS\b/g, "Tee Eee NIMS")  // pronunciation guide, mirrors CLI
    .replace(/\s+/g, " ")
    .trim();
}

// ── Sentence-streaming TTS queue ─────────────────────────────────────
//
// Sentences are enqueued as they arrive from the LLM stream. Each entry
// starts a fetch to /tts immediately (parallel with the previous sentence's
// playback) so audio is ready — or nearly ready — by the time the previous
// sentence finishes. This cuts perceived latency from "wait for full response"
// down to ~first-sentence generation time (~300-600ms).
//
// Queue entry: { blobPromise: Promise<Blob|null> }
// State machine: idle → playing → idle (→ next entry if queue non-empty)

let _audioEl   = null;
let _ttsQueue  = [];      // pending blobPromises
let _playing   = false;
let _queueGen  = 0;       // bumped by stopSpeaking() to cancel in-flight plays

function _fetchSentence(text) {
  return fetch("/tts", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ text }),
  }).then((r) => {
    if (!r.ok) {
      if (r.status === 503) {
        const btn = document.getElementById("tts");
        if (btn) {
          const prev = btn.title;
          btn.title = "TTS unavailable — Piper not installed";
          setTimeout(() => { btn.title = prev; }, 6000);
        }
      }
      return null;
    }
    return r.blob();
  }).catch(() => null);
}

function _playNext(gen) {
  if (gen !== _queueGen || !ttsEnabled) { _playing = false; return; }
  if (_ttsQueue.length === 0) { _playing = false; return; }
  _playing = true;
  const { blobPromise } = _ttsQueue.shift();
  blobPromise.then((blob) => {
    if (gen !== _queueGen || !ttsEnabled || !blob) {
      _playing = false;
      _playNext(gen);
      return;
    }
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    _audioEl = audio;
    audio.addEventListener("ended", () => {
      URL.revokeObjectURL(url);
      _playing = false;
      _playNext(gen);
    });
    audio.addEventListener("error", () => {
      _playing = false;
      _playNext(gen);
    });
    audio.play().catch(() => { _playing = false; _playNext(gen); });
  }).catch(() => { _playing = false; _playNext(gen); });
}

// Enqueue one sentence. Fetch starts immediately in parallel with any
// currently-playing audio so the blob is ready by the time it's needed.
export function enqueueSpeech(text) {
  if (!ttsEnabled) return;
  const cleaned = stripForSpeech(text);
  if (!cleaned) return;
  const gen = _queueGen;
  _ttsQueue.push({ blobPromise: _fetchSentence(cleaned) });
  if (!_playing) _playNext(gen);
}

// One-shot speak (replaces current queue). Used for short announcements
// like "Voice on". For LLM responses use enqueueSpeech() per sentence.
export async function speak(text) {
  if (!ttsEnabled) return;
  stopSpeaking();
  enqueueSpeech(text);
}

export function stopSpeaking() {
  _queueGen++;            // invalidates all in-flight _playNext callbacks
  _ttsQueue = [];
  _playing  = false;
  if (_audioEl) {
    try {
      _audioEl.pause();
      _audioEl.currentTime = 0;
      if (_audioEl.src?.startsWith("blob:")) URL.revokeObjectURL(_audioEl.src);
      _audioEl.removeAttribute("src");
      _audioEl.load();
    } catch {}
    _audioEl = null;
  }
}

export function isTtsEnabled() { return ttsEnabled; }
