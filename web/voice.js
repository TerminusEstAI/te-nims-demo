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
  r.continuous     = true;   // stay on until the user toggles off
  r.interimResults = false;
  r.maxAlternatives = 1;
  return r;
}

export function initVoice({ onTranscript, getReadable }) {
  const micBtn  = document.getElementById("mic");
  const ttsBtn  = document.getElementById("tts");

  // ── Mic / push-to-talk ─────────────────────────────────────────────
  recognition = makeRecognition();
  if (recognition && micBtn) {
    micBtn.disabled = false;
    micBtn.title = "Click to start listening · click again to stop";

    const _msState = (state) => {
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state;
    };

    const start = () => {
      if (listening) return;
      _claimAudioSession();
      try {
        recognition.start();
        listening = true;
        micBtn.classList.add("listening");
        micBtn.title = "Listening… click or press PTT to stop";
        _msState("playing");
      } catch (e) { /* already started — ignore */ }
    };
    const stop = () => {
      if (!listening) return;
      try { recognition.stop(); } catch {}
      listening = false;
      micBtn.classList.remove("listening");
      micBtn.title = "Click to start listening · click again to stop";
      _msState("paused");
    };
    const toggle = () => { listening ? stop() : start(); };

    // Claim audio session on first any user gesture so macOS routes the
    // BlueParrott button to Chrome before the operator ever touches the mic.
    const _firstGesture = () => { _claimAudioSession(); };
    document.addEventListener("click",   _firstGesture, { once: true });
    document.addEventListener("keydown", _firstGesture, { once: true });

    // Click-to-toggle on the on-screen mic button
    micBtn.addEventListener("click",      toggle);
    micBtn.addEventListener("touchstart", (e) => { e.preventDefault(); toggle(); });

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
        e.preventDefault();
        toggle();
      }
    });

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play",  () => { if (!listening) toggle(); });
      navigator.mediaSession.setActionHandler("pause", () => { if (listening)  toggle(); });
    }

    recognition.addEventListener("result", (ev) => {
      // With continuous=true, results accumulate — only take the latest final one.
      const results = ev.results;
      for (let i = ev.resultIndex; i < results.length; i++) {
        if (results[i].isFinal) {
          const transcript = results[i][0]?.transcript?.trim();
          if (transcript && onTranscript) onTranscript(transcript);
        }
      }
    });
    recognition.addEventListener("end", () => {
      // Browser stopped recognition — restart if the user hasn't toggled off.
      if (listening) {
        try { recognition.start(); } catch (e) { /* ignore */ }
      } else {
        micBtn.classList.remove("listening");
        micBtn.title = "Click to start listening · click again to stop";
      }
    });
    recognition.addEventListener("error", (ev) => {
      if (ev.error === "no-speech") return; // expected in continuous mode — just keep going
      listening = false;
      micBtn.classList.remove("listening");
      micBtn.title = "Click to start listening · click again to stop";
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
