#!/usr/bin/env python3
"""Tile-aware static file server for the TE NIMS FOB web demo.

Wraps http.server with one extra route:

    GET /tiles/{z}/{x}/{y}.png  →  PNG tile read from a local MBTiles SQLite

MBTiles uses TMS y-axis (origin bottom-left). Browsers / Leaflet send XYZ
y-axis (origin top-left). We flip y on read.

Usage:
    cd DEMOS/severian-fob-web
    python3 serve.py                       # 0.0.0.0:8765, default mbtiles
    python3 serve.py --port 9000           # custom port
    python3 serve.py --mbtiles /path.mbtiles

The default MBTiles path is `./imagery-cache/moore-okc-esri-z14-z16.mbtiles`.
For offline FOB deployment, ship this server + the .mbtiles file alongside
the static HTML/JS bundle. Total package: < 1GB for OKC metro at z14-z16.
"""
from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import sqlite3
import sys
import http.cookies as _http_cookies
import threading
import uuid as _uuid
from pathlib import Path

# Make severian_memory.py importable from the sibling ollama demo directory.
# Both surfaces share the same Mem0+Qdrant store at ~/.severian/chats/qdrant.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "severian-ollama"))

_memory_instance = None
_memory_lock = threading.Lock()


def _get_memory():
    """Return a SeverianMemory instance, lazy-initialised on first call.

    Returns None (silently) if mem0ai is not installed — the web demo
    continues to work without memory, endpoints return {"enabled": false}.
    """
    global _memory_instance
    if _memory_instance is not None:
        return _memory_instance
    with _memory_lock:
        if _memory_instance is not None:
            return _memory_instance
        try:
            from severian_memory import SeverianMemory  # type: ignore[import]
            ollama_url = os.environ.get("SEVERIAN_OLLAMA_URL", EMBED_OLLAMA_URL)
            _memory_instance = SeverianMemory(ollama_url=ollama_url, llm_model="llama3.2:3b")
        except Exception:
            pass
    return _memory_instance

DEFAULT_MBTILES = "imagery-cache/moore-esri-z11-z16.mbtiles"
DEFAULT_PORT    = 8765

# Artifact directories — the SPA's Artifacts tab scans these for chronological
# display. plot_generate writes here, viz_tools writes here, etc.
# Using tempfile.gettempdir() so this works on Windows (%TEMP%), macOS, and Linux (/tmp).
# Optional — missing dirs are silently skipped.
import tempfile as _tempfile
_tmp = Path(_tempfile.gettempdir())
ARTIFACT_DIRS: dict[str, Path] = {
    "chart":  _tmp / "severian-charts",
    "viz":    _tmp / "te-viz",
    "map":    _tmp / "severian-maps",
    "upload": _tmp / "severian-uploads",
    "doc":    _tmp / "severian-docs",
}

# Document RAG — extracted text + embeddings for PDFs the operator drags
# from the Library into the chat. First /document/prepare call for a given
# PDF chunks + embeds the whole file (slow for large docs, ~30-60s for
# FEMA-NIMS-Doctrine; sub-second for ICS forms); subsequent calls return
# the cached doc_id instantly. /document/query embeds the query, runs
# cosine similarity over the cached chunk embeddings, returns top-k.
DOCUMENT_CACHE_DIR = Path(os.environ.get(
    "SEVERIAN_DOCUMENT_CACHE_DIR", "data/document-cache"))
def _resolve_ollama_url() -> str:
    """Return the first reachable Ollama URL, probing :11434 then :11500.

    Allows serve.py to run on either Studio (Ollama direct on :11434) or
    MacBook (Ollama tunnelled to :11500) without any env-var override.
    SEVERIAN_EMBED_URL always wins if set.
    """
    explicit = os.environ.get("SEVERIAN_EMBED_URL", "").strip()
    if explicit:
        return explicit
    import urllib.request as _ur  # noqa: PLC0415
    for candidate in ("http://127.0.0.1:11434", "http://127.0.0.1:11500"):
        try:
            _ur.urlopen(f"{candidate}/api/tags", timeout=2).close()
            return candidate
        except Exception:
            pass
    # Neither reachable at startup — default to :11434 and let embedding fail
    # with a clear error at request time rather than at boot.
    return "http://127.0.0.1:11434"


EMBED_OLLAMA_URL = _resolve_ollama_url()
EMBED_MODEL = os.environ.get("SEVERIAN_EMBED_MODEL", "nomic-embed-text")
DOC_CHUNK_TOKENS = 500
DOC_CHUNK_OVERLAP = 100
DOC_MAX_CHARS = 4 * DOC_CHUNK_TOKENS   # rough char-per-token approx

# Library — read-only NIMS doctrine PDF corpus surfaced in the Library tab.
# Lives in the sibling severian-ollama demo dir today (62 PDFs, ~20 MB:
# FEMA NIMS doctrine, NRF, ESF-01..15, ICS-2xx forms, etc.). The Library tab
# renders these grouped by category so the operator can see what doctrine
# the agent has access to and click any title to open it in a new window.
def _resolve_library_dir() -> Path:
    if env := os.environ.get("SEVERIAN_LIBRARY_DIR"):
        return Path(env)
    candidates = [
        Path(__file__).parent / "library" / "pdfs",
        Path(__file__).parent.parent / "severian-ollama" / "library" / "pdfs",
        Path(__file__).resolve().parents[2] / "DEMOS" / "severian-ollama" / "library" / "pdfs",
        Path.home() / "AI" / "TERMINUSEST-AI" / "DEMOS" / "severian-ollama" / "library" / "pdfs",
    ]
    for c in candidates:
        if c.is_dir() and any(c.glob("*.pdf")):
            return c
    return candidates[0]  # fallback (may be empty)

LIBRARY_DIR = _resolve_library_dir()

# Saved-forms — versioned snapshots auto-created by the ICS file watcher
# whenever an ICS PDF in LIBRARY_DIR is modified (e.g. saved from Preview).
# Lives in the app root (thumbdrive).  Filenames: <stem>_YYYYMMDD-HHMMSS.pdf
SAVED_FORMS_DIR = Path(__file__).parent / "saved-forms"
SAVED_FORMS_DIR.mkdir(exist_ok=True)

# ── ICS file watcher ───────────────────────────────────────────────────────
# Background thread: polls LIBRARY_DIR every 4 s for ICS PDF mtime changes.
# On change → writes a versioned snapshot to SAVED_FORMS_DIR automatically.
# The operator opens the file in their default PDF app, edits, saves there —
# the watcher picks it up with no extra clicks required.
_ics_watch_mtimes: dict[str, float] = {}

def _ics_file_watcher() -> None:
    import re as _re, time as _time, datetime as _datetime
    # Seed initial mtimes on first pass so we don't version every file at boot.
    seeded = False
    while True:
        if LIBRARY_DIR.is_dir():
            for p in LIBRARY_DIR.iterdir():
                if p.suffix.lower() != ".pdf" or not p.name.lower().startswith("ics-"):
                    continue
                try:
                    mtime = p.stat().st_mtime
                except OSError:
                    continue
                prev = _ics_watch_mtimes.get(p.name)
                if seeded and prev is not None and mtime > prev:
                    base = _re.sub(r"_\d{8}-\d{6}$", "", p.stem)
                    ts = _datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
                    dest = SAVED_FORMS_DIR / f"{base}_{ts}.pdf"
                    try:
                        pdf_bytes = p.read_bytes()
                        dest.write_bytes(pdf_bytes)
                        print(f"[ics-watcher] versioned {p.name} → {dest.name}", flush=True)
                        _append_vpo_for_pdf_save(dest.name, pdf_bytes)
                    except OSError as e:
                        print(f"[ics-watcher] write failed: {e}", flush=True)
                _ics_watch_mtimes[p.name] = mtime
        seeded = True
        _time.sleep(4)

threading.Thread(target=_ics_file_watcher, daemon=True, name="ics-watcher").start()


def _append_vpo_for_pdf_save(saved_as: str, pdf_bytes: bytes) -> dict | None:
    """Create and append a VPO chain block recording a PDF version save.

    Extracts form_type from the filename, hashes the bytes, signs with
    HMAC-SHA256 (same fallback as /vpo/sign), and appends under _CHAIN_LOCK.
    Returns the block dict (caller may include block_hash in HTTP response).
    Never raises — logs errors and returns None on failure.
    """
    import hashlib as _hashlib
    import hmac as _hmac
    import json as _json
    import re as _re
    from datetime import datetime, timezone

    try:
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        m = _re.match(r"(ICS-\d+[A-Z]*)", saved_as, _re.IGNORECASE)
        form_type = m.group(1).upper() if m else "ICS-FORM"
        sha256 = _hashlib.sha256(pdf_bytes).hexdigest()
        pdf_url = f"/library/{saved_as}"

        form_data = {
            "saved_as": saved_as,
            "pdf_url": pdf_url,
            "sha256": sha256,
            "saved_at": now_iso,
        }

        vpo = {
            "entityId": f"ics-form-{saved_as}",
            "version": 1,
            "createdTime": now_iso,
            "updatedTime": now_iso,
            "isLive": True,
            "ontology": {"platformType": "vpo", "specificType": form_type, "domain": "civilian"},
            "aliases": {"name": f"{form_type} · {now_iso}"},
            "vpoDomainData": form_data,
        }
        vpo_json = _json.dumps(vpo, separators=(",", ":"), sort_keys=True)
        payload_hash = _hashlib.sha256(vpo_json.encode("utf-8")).hexdigest()

        signing_spec = _read_signing_key()
        hmac_key = signing_spec["key"].encode("utf-8")
        signature = _hmac.new(hmac_key, vpo_json.encode("utf-8"), _hashlib.sha256).hexdigest()

        with _CHAIN_LOCK:
            prev_sig = None
            if _chain_log_path().is_file():
                with open(_chain_log_path(), "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            blk = _json.loads(line)
                            sig = blk.get("signature")
                            if isinstance(sig, str):
                                prev_sig = sig
                        except Exception:
                            continue

            prev_hash = prev_sig or ("0" * 64)
            block_hash = _hashlib.sha256((prev_hash + payload_hash).encode("utf-8")).hexdigest()

            block = {
                "form_type": form_type,
                "form_data": form_data,
                "signer": "fob-server",
                "signed_at": now_iso,
                "algorithm": "HMAC-SHA256",
                "signing_key_id": signing_spec["key_id"],
                "signature": signature,
                "prev_signature": prev_sig,
                "block_hash": block_hash,
                "prev_hash": prev_hash,
                "payload_hash": payload_hash,
            }

            _chain_log_path().parent.mkdir(parents=True, exist_ok=True)
            with open(_chain_log_path(), "a", encoding="utf-8") as f:
                f.write(_json.dumps(block, separators=(",", ":")) + "\n")

        print(f"[vpo] chain block appended for {saved_as} → {block_hash[:16]}…", flush=True)
        return block
    except Exception as e:
        print(f"[vpo] _append_vpo_for_pdf_save failed: {e}", flush=True)
        return None


# Chat log — append-only on-disk record of every signed chat turn. Each turn
# is one JSON file (`<turn-id>.json`) containing the FULL signed envelope
# (full response, not truncated). The IndexedDB chain block stores a
# `log_path` pointer so anyone with the thumb drive can re-hash the file's
# response field and verify it matches the chain block's response_hash.
#
# Default lives under `data/chat-log/` (sibling of `data/ollama-models/` etc.)
# so it survives reboots and ships when the operator copies `data/`.
CHAT_LOG_DIR = Path(os.environ.get("SEVERIAN_CHAT_LOG_DIR", "data/chat-log"))
_BASE_CHAT_LOG_DIR = CHAT_LOG_DIR
_session_local = threading.local()

def _chat_log_dir() -> Path:
    sid = getattr(_session_local, "session_id", None)
    if sid:
        d = _BASE_CHAT_LOG_DIR / "sessions" / sid
        d.mkdir(parents=True, exist_ok=True)
        return d
    return CHAT_LOG_DIR

_TURN_ID_RE = "^[a-zA-Z0-9_-]{1,80}\\.json$"  # restrict to safe filenames

# Chain mirror — server-side append-only JSONL of every signed block the SPA
# emits. Survives the browser-data clear that would otherwise nuke the
# IndexedDB chain. GET /chain rehydrates a fresh tab on first load. When the
# operator copies the data/ dir off the thumb drive, the chain travels with
# it as a plain file (greppable, diffable, importable).
CHAIN_LOG_PATH = Path(os.environ.get("SEVERIAN_CHAIN_LOG", "data/chain.jsonl"))
_BASE_CHAIN_LOG_PATH = CHAIN_LOG_PATH
_CHAIN_LOCK = threading.Lock()  # serializes append-writes from concurrent clients

def _chain_log_path() -> Path:
    sid = getattr(_session_local, "session_id", None)
    if sid:
        p = _BASE_CHAT_LOG_DIR / "sessions" / sid / "chain.jsonl"
        p.parent.mkdir(parents=True, exist_ok=True)
        return p
    return CHAIN_LOG_PATH

# Signing identity — see _read_signing_key() below. Loaded from
# data/.signing-key.json on first request, cached afterwards. Defaults to a
# demo key if no file is present so the SPA still works out-of-the-box.
SIGNING_KEY_PATH = Path(os.environ.get("SEVERIAN_SIGNING_KEY", "data/.signing-key.json"))
_SIGNING_KEY_DEFAULT = {
    "key_id":   "demo:te-nims-fob-demo-key",
    "key":      "te-nims-fob-demo-key",
    "scheme":   "HMAC-SHA256",
    "loaded_from": "default",
}

# te-verify binary — used by POST /verify + /verify-mirror to actually
# do the audit work (HMAC verification + chain linkage). Search order:
#   1. $SEVERIAN_TE_VERIFY_BIN
#   2. ./runtime/te-verify-<platform>  (thumb-drive bundled per-platform)
#   3. <repo>/rust/target/release/te-verify  (host dev build)
TE_VERIFY_BIN_ENV = os.environ.get("SEVERIAN_TE_VERIFY_BIN", "")
ARTIFACT_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".html")
ARTIFACT_MIME = {
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif":  "image/gif",
    ".svg":  "image/svg+xml",
    ".html": "text/html; charset=utf-8",
}

# Piper TTS — same voice as the CLI demo (en_GB-alan-medium per
# feedback_no_macos_say_in_repo + project_severian_voice_choice).
# Voice ONNX cached at ~/.severian/voices/ (synced from Studio for dev,
# bundled on the FOB thumbdrive for production).
PIPER_VOICE_DIR = Path(os.path.expanduser("~/.severian/voices"))
PIPER_VOICE     = os.environ.get("SEVERIAN_PIPER_VOICE", "en_GB-alan-medium")
PIPER_LENGTH_SCALE = float(os.environ.get("SEVERIAN_PIPER_LENGTH_SCALE", "0.91"))
_piper_voice_cache = None  # lazy-loaded PiperVoice instance


_signing_key_cache: dict | None = None
_signing_key_lock = threading.Lock()

def _read_signing_key() -> dict:
    """Load the signing key from data/.signing-key.json (lazy + cached).
    Falls back to the demo key if no file is present.

    File format (operator drops this on a thumb drive to swap demo → prod):
        {
          "key_id":  "fema-region-6-2026",  // ← any non-"demo:"/"training:" prefix
          "key":     "<long random string>", // raw HMAC key
          "scheme":  "HMAC-SHA256"
        }
    """
    global _signing_key_cache
    if _signing_key_cache is not None:
        return _signing_key_cache
    with _signing_key_lock:
        if _signing_key_cache is not None:
            return _signing_key_cache
        if SIGNING_KEY_PATH.is_file():
            try:
                import json as _json  # noqa: PLC0415
                spec = _json.loads(SIGNING_KEY_PATH.read_text(encoding="utf-8"))
                # Required fields
                if not isinstance(spec, dict) or not spec.get("key_id") or not spec.get("key"):
                    raise ValueError("missing key_id or key")
                spec.setdefault("scheme", "HMAC-SHA256")
                spec["loaded_from"] = str(SIGNING_KEY_PATH)
                _signing_key_cache = spec
                return spec
            except Exception as e:
                # Bad file → fall through to demo so the SPA still loads,
                # but log loud so the operator notices in serve.log.
                print(f"WARN: {SIGNING_KEY_PATH} unreadable: {e} — falling back to demo key",
                      file=sys.stderr)
        _signing_key_cache = dict(_SIGNING_KEY_DEFAULT)
        return _signing_key_cache


_DAMAGE_GEOJSONL = (
    "DATA", "datapacks", "moore-ok-tornado-v1", "buildings", "damage_classified.geojsonl"
)

def _find_damage_classified() -> Path:
    """Locate damage_classified.geojsonl — checks repo and FOB-image layouts."""
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent.parent.joinpath(*_DAMAGE_GEOJSONL),
        here.parent.parent.joinpath("data", "datapacks",
                                    "moore-ok-tornado-v1", "buildings", "damage_classified.geojsonl"),
    ]
    for p in candidates:
        if p.is_file():
            return p
    return candidates[0]

def _find_te_verify() -> Path | None:
    """Locate the te-verify binary. Search order:
      1. $SEVERIAN_TE_VERIFY_BIN if set
      2. ./runtime/te-verify-<platform>  (thumb-drive bundled)
      3. <repo>/rust/target/release/te-verify  (host dev build)
    Returns None if not found.
    """
    import platform as _platform  # noqa: PLC0415
    if TE_VERIFY_BIN_ENV and Path(TE_VERIFY_BIN_ENV).is_file():
        return Path(TE_VERIFY_BIN_ENV)
    arch = _platform.machine().lower()
    sysname = _platform.system().lower()
    bundle_name = {
        ("darwin",  "arm64"):  "te-verify-mac-arm64",
        ("darwin",  "x86_64"): "te-verify-mac-x64",
        ("linux",   "x86_64"): "te-verify-linux-x64",
        ("windows", "amd64"):  "te-verify-win-x64.exe",
        ("windows", "x86_64"): "te-verify-win-x64.exe",
    }.get((sysname, arch), "te-verify")
    here = Path(__file__).resolve().parent
    runtime_bin = here / "runtime" / bundle_name
    if runtime_bin.is_file():
        return runtime_bin
    # Host dev build: walk up to find rust/target/release/te-verify
    for parent in here.parents:
        candidate = parent / "rust" / "target" / "release" / "te-verify"
        if candidate.is_file():
            return candidate
    return None


def _piper_voice():
    """Lazy-load the Piper voice. Cached for the server's lifetime."""
    global _piper_voice_cache
    if _piper_voice_cache is not None:
        return _piper_voice_cache
    try:
        from piper import PiperVoice  # noqa: PLC0415
    except ImportError:
        return None
    onnx = PIPER_VOICE_DIR / f"{PIPER_VOICE}.onnx"
    js   = PIPER_VOICE_DIR / f"{PIPER_VOICE}.onnx.json"
    if not (onnx.is_file() and js.is_file()):
        return None
    try:
        _piper_voice_cache = PiperVoice.load(str(onnx))
        return _piper_voice_cache
    except Exception:
        return None


class TileHandler(http.server.SimpleHTTPRequestHandler):
    """Serve static files normally + intercept /tiles/{z}/{x}/{y}.png."""

    mbtiles_path: str = DEFAULT_MBTILES  # set on the class before instantiation

    def _init_session(self) -> None:
        cookies = _http_cookies.SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookies.get("svs_session")
        if morsel and len(morsel.value) == 36:
            _session_local.session_id = morsel.value
            self._new_session = False
        else:
            _session_local.session_id = str(_uuid.uuid4())
            self._new_session = True

    def send_response(self, code: int, message: str | None = None) -> None:
        super().send_response(code, message)
        if getattr(self, "_new_session", False):
            sid = getattr(_session_local, "session_id", "")
            self.send_header(
                "Set-Cookie",
                f"svs_session={sid}; Path=/; Max-Age=14400; HttpOnly; SameSite=Lax",
            )
            self._new_session = False

    def end_headers(self) -> None:
        # Force-disable HTTP caching for static frontend assets so Chrome's
        # disk cache can't serve stale JS/CSS/HTML after an edit. The SW does
        # its own (network-first) caching layer for offline resilience —
        # browser-level HTTP cache is pure footgun for a dev surface.
        # Asset endpoints that benefit from caching (tiles, artifacts,
        # voice files) override Cache-Control explicitly via send_header
        # before this runs, and that header takes precedence.
        path = self.path.split("?", 1)[0]
        if path.endswith((".html", ".js", ".css", ".json", "/")):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    # ── Tiles ─────────────────────────────────────────────────────────
    _tms_flip_cache: dict = {}  # mbtiles_path → bool, populated on first tile request

    @classmethod
    def _is_tms(cls, path: str) -> bool:
        """Detect whether an MBTiles file uses TMS (y=0 at south) or XYZ (y=0 at north).

        Probes the minimum tile_row at the lowest available zoom. For the OKC/Moore
        area (~35°N), TMS rows are high (≥1000 at z11), XYZ rows are low (<600 at z11).
        A threshold of 800 cleanly separates the two for any mid-latitude tile set.
        """
        if path in cls._tms_flip_cache:
            return cls._tms_flip_cache[path]
        result = False
        try:
            con = sqlite3.connect(path)
            cur = con.cursor()
            cur.execute("SELECT zoom_level, MIN(tile_row) FROM tiles GROUP BY zoom_level ORDER BY zoom_level LIMIT 1")
            row = cur.fetchone()
            con.close()
            if row:
                z_probe, min_row = row
                threshold = (2 ** z_probe) // 2
                result = min_row > threshold
        except sqlite3.Error:
            pass
        cls._tms_flip_cache[path] = result
        return result

    def _serve_tile(self, z: int, x: int, y: int) -> None:
        # MBTiles may store rows in TMS (y=0 at south, flip needed) or XYZ (y=0 at
        # north, no flip). Auto-detect once per file via _is_tms().
        y_db = (2 ** z - 1 - y) if self._is_tms(self.mbtiles_path) else y
        try:
            con = sqlite3.connect(self.mbtiles_path)
            cur = con.cursor()
            cur.execute(
                "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, y_db),
            )
            row = cur.fetchone()
            con.close()
        except sqlite3.Error as e:
            self.send_error(500, f"mbtiles error: {e}")
            return
        if row is None:
            # Return a transparent 1×1 PNG so the browser gets 200 and the
            # console stays quiet. Leaflet's errorTileUrl is the visual fallback;
            # this kills the 404 noise for out-of-coverage tiles.
            blank = (
                b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01"
                b"\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
                b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
                b"\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
            )
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(blank)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(blank)
            return
        data = row[0]
        # ESRI returns JPEG even when the URL ends in .png. Detect from
        # magic bytes so the browser gets a correct Content-Type.
        mime = "image/png"
        if len(data) >= 3:
            if data[:3] == b"\xff\xd8\xff":          mime = "image/jpeg"
            elif data[:8] == b"\x89PNG\r\n\x1a\n":   mime = "image/png"
            elif data[:6] in (b"GIF87a", b"GIF89a"): mime = "image/gif"
            elif data[:4] == b"RIFF":                mime = "image/webp"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        # Long cache — tiles are immutable
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(data)

    def _serve_tts(self, text: str) -> None:
        """Synthesize text via Piper subprocess, return WAV bytes.

        Runs piper in a child process so an onnxruntime segfault can't kill
        serve.py. Same voice as the CLI (en_GB-alan-medium).
        """
        if not text:
            self.send_error(400, "missing text")
            return
        if len(text) > 8000:
            text = text[:8000]

        onnx = PIPER_VOICE_DIR / f"{PIPER_VOICE}.onnx"
        cfg_path = PIPER_VOICE_DIR / f"{PIPER_VOICE}.onnx.json"
        if not onnx.is_file():
            self.send_error(503,
                f"Piper voice not found — install piper-tts and download "
                f"{PIPER_VOICE}.onnx to {PIPER_VOICE_DIR}")
            return

        import subprocess as _sp  # noqa: PLC0415
        import io as _io          # noqa: PLC0415
        import wave as _wave      # noqa: PLC0415
        import json as _json2     # noqa: PLC0415
        import sys as _sys        # noqa: PLC0415

        # Locate the piper binary — prefer a venv binary over sys.executable -m piper
        # so the server works when running from a worktree without its own venv.
        def _find_piper_cmd() -> list:
            _here = Path(__file__).resolve().parent
            # On Windows: venv uses Scripts\piper.exe; on Unix: bin/piper
            _is_win = _sys.platform == "win32"
            _venv_bin = "Scripts" if _is_win else "bin"
            _exe = "piper.exe" if _is_win else "piper"
            candidates = [
                # Thumbdrive bundle: bin/piper or bin/piper.exe next to web/
                _here.parent / "bin" / _exe,
                # venv-local piper
                _here / ".venv" / _venv_bin / _exe,
                _here.parent.parent / "DEMOS" / "severian-fob-web" / ".venv" / _venv_bin / _exe,
                Path.home() / "AI" / "TERMINUSEST-AI" / "DEMOS" / "severian-fob-web" / ".venv" / _venv_bin / _exe,
                Path.home() / "AI" / "TERMINUSEST-AI" / "DEMOS" / "severian-ollama" / ".venv" / _venv_bin / _exe,
            ]
            for c in candidates:
                if c.is_file():
                    return [str(c)]
            # fallback: hope sys.executable has piper installed
            return [_sys.executable, "-m", "piper"]

        # Sample rate lives in the voice config JSON (e.g. 22050 for alan-medium)
        sample_rate = 22050
        if cfg_path.is_file():
            try:
                sample_rate = _json2.loads(cfg_path.read_text()).get(
                    "audio", {}).get("sample_rate", 22050)
            except Exception:
                pass

        piper_cmd = _find_piper_cmd()
        try:
            result = _sp.run(
                [*piper_cmd,
                 "--model", str(onnx),
                 "--length_scale", str(PIPER_LENGTH_SCALE),
                 "--output_raw"],
                input=text.encode("utf-8"),
                capture_output=True,
                timeout=30,
            )
        except FileNotFoundError:
            self.send_error(503, "piper not installed — pip install piper-tts")
            return
        except _sp.TimeoutExpired:
            self.send_error(504, "piper synthesis timed out (>30s)")
            return
        except Exception as e:
            self.send_error(500, f"piper subprocess error: {e}")
            return

        if result.returncode != 0:
            err = result.stderr.decode("utf-8", errors="replace")[:300]
            self.send_error(500, f"piper exit {result.returncode}: {err}")
            return

        raw_pcm = result.stdout
        if not raw_pcm:
            self.send_error(500, "piper produced no audio")
            return

        # Wrap raw 16-bit mono PCM in a WAV container for the browser
        buf = _io.BytesIO()
        with _wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(raw_pcm)
        data = buf.getvalue()

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ── Ollama proxy ─────────────────────────────────────────────────
    def _proxy_ollama(self, method: str) -> None:
        """Proxy Ollama API requests through serve.py to avoid browser CORS.

        Browser → GET/POST http://localhost:8765/api/ollama/<path>
                → GET/POST EMBED_OLLAMA_URL/<path>

        Streams the upstream response so /api/chat NDJSON works without
        buffering the full response in memory.
        """
        import urllib.request as _ur
        import urllib.error as _ue

        upstream_path = self.path.removeprefix("/api/ollama")
        if not upstream_path.startswith("/"):
            upstream_path = "/" + upstream_path
        upstream_url = f"{EMBED_OLLAMA_URL}{upstream_path}"

        body = b""
        if method == "POST":
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length)

        req = _ur.Request(
            upstream_url,
            data=body or None,
            method=method,
        )
        req.add_header("Content-Type",
                       self.headers.get("Content-Type", "application/json"))

        try:
            upstream = _ur.urlopen(req, timeout=300)
        except _ue.URLError as exc:
            self.send_error(503, f"Ollama proxy: {exc.reason}")
            return
        except OSError as exc:
            self.send_error(503, f"Ollama proxy: {exc}")
            return

        self.send_response(upstream.status)
        self.send_header("Content-Type",
                         upstream.headers.get("Content-Type", "application/octet-stream"))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            while True:
                chunk = upstream.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            upstream.close()

    # ── Artifacts ────────────────────────────────────────────────────
    def _list_artifacts(self) -> None:
        """GET /artifacts → JSON list of every image under ARTIFACT_DIRS,
        newest first. Each entry: {id, type, name, size, mtime_iso, dir}.

        id is `<type>:<basename>` so /artifacts/<id> can route by type.
        """
        import datetime as _dt
        import json as _json
        items: list[dict] = []
        for kind, root in ARTIFACT_DIRS.items():
            if not root.is_dir():
                continue
            for p in root.iterdir():
                if not p.is_file():
                    continue
                if p.suffix.lower() not in ARTIFACT_EXTS:
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                items.append({
                    "id": f"{kind}:{p.name}",
                    "type": kind,
                    "name": p.name,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "mtime_iso": _dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                    "dir": str(root),
                })
        items.sort(key=lambda d: d["mtime"], reverse=True)
        body = _json.dumps({"count": len(items), "items": items}, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_artifact(self, artifact_id: str) -> None:
        """GET /artifacts/<id> → the raw image bytes. id is `<type>:<basename>`.
        Path safety: basename must contain no slashes and must resolve under
        the type's ARTIFACT_DIR (no `..` escape)."""
        if ":" not in artifact_id:
            self.send_error(400, "artifact id must be <type>:<basename>")
            return
        kind, _, name = artifact_id.partition(":")
        root = ARTIFACT_DIRS.get(kind)
        if root is None:
            self.send_error(404, f"unknown artifact type: {kind}")
            return
        # F-7: also reject any dot-prefixed name (.signing-key.json, .git/HEAD,
        # any future hidden file) so future config drift that points
        # ARTIFACT_DIRS at data/ doesn't silently expose secrets.
        if "/" in name or "\\" in name or name.startswith("..") or name.startswith("."):
            self.send_error(400, "invalid artifact name")
            return
        path = (root / name).resolve()
        try:
            path.relative_to(root.resolve())
        except ValueError:
            self.send_error(400, "artifact path escapes its type root")
            return
        if not path.is_file():
            self.send_error(404, "artifact not found")
            return
        try:
            data = path.read_bytes()
        except OSError as e:
            self.send_error(500, f"read failed: {e}")
            return
        mime = ARTIFACT_MIME.get(path.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(data)

    def _save_doc_artifact(self) -> None:
        """POST /artifacts/save — body: {"title": "...", "html": "..."}.
        Writes the HTML to /tmp/severian-docs/<timestamp>-<slug>.html and
        returns {"id": "doc:<filename>", "url": "/artifacts/doc:<filename>"}.
        """
        import json as _json  # noqa: PLC0415
        import re as _re      # noqa: PLC0415
        import time as _time  # noqa: PLC0415

        length = int(self.headers.get("Content-Length", 0))
        try:
            body   = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = _json.loads(body)
        except Exception as e:
            self.send_error(400, f"bad request: {e}")
            return

        title = (payload.get("title") or "document").strip()[:80]
        html  = (payload.get("html") or "").strip()
        if not html:
            self.send_error(400, "html field is required")
            return

        # Build a filesystem-safe slug from the title
        slug = _re.sub(r"[^a-zA-Z0-9_-]", "-", title).strip("-").lower()[:40] or "doc"
        ts   = int(_time.time())
        fname = f"{ts}-{slug}.html"

        doc_dir = ARTIFACT_DIRS["doc"]
        doc_dir.mkdir(parents=True, exist_ok=True)
        path = doc_dir / fname
        path.write_text(html, encoding="utf-8")

        artifact_id = f"doc:{fname}"
        out = _json.dumps({
            "id":  artifact_id,
            "url": f"/artifacts/{artifact_id}",
            "name": fname,
        }).encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    # ── Tool execution (ReAct agent loop) ────────────────────────────────
    def _execute_tool(self, tool_name: str) -> None:
        """POST /tools/<name> — execute a named tool and return a JSON result.

        Called by the client-side ReAct loop after the model emits a
        <tool_call> block.  Each tool receives the parsed args dict and
        returns a plain JSON-serialisable dict.
        """
        import json as _json  # noqa: PLC0415

        length = int(self.headers.get("Content-Length", 0))
        try:
            raw  = self.rfile.read(length).decode("utf-8") if length else "{}"
            args = _json.loads(raw) if raw.strip() else {}
        except Exception as e:
            self.send_error(400, f"bad args: {e}")
            return

        dispatch: dict = {
            "search_doctrine":    self._tool_search_doctrine,
            "get_damage_summary": self._tool_get_damage_summary,
            "get_scenario_info":  self._tool_get_scenario_info,
            "list_resources":     self._tool_list_resources,
            "find_closest":       self._tool_find_closest,
            # Aliases — model may call these by trained names; route to find_closest
            "geo_resolve_closest_medical_facility": lambda a: self._tool_find_closest({**a, "type": "hospital"}),
            "find_nearest_hospital":                lambda a: self._tool_find_closest({**a, "type": "hospital"}),
            "get_nearest_hospital":                 lambda a: self._tool_find_closest({**a, "type": "hospital"}),
            "find_nearest_shelter":                 lambda a: self._tool_find_closest({**a, "type": "shelter"}),
            "find_nearest_staging":                 lambda a: self._tool_find_closest({**a, "type": "staging"}),
            # geo_tools / odin_tools namespace aliases (model may use either prefix)
            "geo_resolve_aoi":                       self._tool_geo_resolve_aoi,
            "odin_tools.geo_resolve_aoi":            self._tool_geo_resolve_aoi,
            "geo_tools.geo_resolve_aoi":             self._tool_geo_resolve_aoi,
            "odin_tools.geo_resolve_closest_medical_facility": lambda a: self._tool_find_closest({**a, "type": "hospital"}),
            "odin_tools.find_nearest_hospital":      lambda a: self._tool_find_closest({**a, "type": "hospital"}),
            "odin_tools.find_nearest_shelter":       lambda a: self._tool_find_closest({**a, "type": "shelter"}),
            "odin_tools.list_resources":             self._tool_list_resources,
            "odin_tools.query_layer":                self._tool_odin_query_layer,
        }
        fn = dispatch.get(tool_name)
        if fn is None:
            # Return 200 with a JSON error — HTTP 404 causes executeTool() to
            # throw before the model can read the message and self-correct.
            import json as _j  # noqa: PLC0415
            body = _j.dumps({
                "error": f"Tool '{tool_name}' is not available.",
                "available_tools": list(dispatch),
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            result = fn(args)
        except Exception as e:
            result = {"error": str(e)}

        body = _json.dumps(result, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _tool_search_doctrine(self, args: dict) -> dict:
        """search_doctrine(query) — cosine-similarity search over all prepared docs."""
        import json as _json, math as _math, urllib.request as _ur  # noqa: PLC0415

        query = (args.get("query") or "").strip()
        if not query:
            return {"error": "query is required"}

        cache_dir = DOCUMENT_CACHE_DIR
        if not cache_dir.is_dir() or not list(cache_dir.glob("*.json")):
            return {
                "results": [],
                "note": "No doctrine documents prepared. Drag a PDF from the Library tab into chat first.",
            }

        # Embed query via Ollama nomic-embed-text
        payload = _json.dumps({"model": EMBED_MODEL, "prompt": query}).encode("utf-8")
        ereq = _ur.Request(
            f"{EMBED_OLLAMA_URL}/api/embeddings",
            data=payload, headers={"Content-Type": "application/json"},
        )
        try:
            with _ur.urlopen(ereq, timeout=20) as resp:
                qe = _json.loads(resp.read().decode("utf-8")).get("embedding", [])
        except Exception as e:
            return {"error": f"embedding failed: {e}"}
        if not qe:
            return {"error": "empty query embedding"}

        def cos(a: list, b: list) -> float:
            num = sum(x * y for x, y in zip(a, b))
            da  = _math.sqrt(sum(x * x for x in a))
            db  = _math.sqrt(sum(x * x for x in b))
            return num / (da * db) if da and db else 0.0

        scored: list[dict] = []
        for cf in cache_dir.glob("*.json"):
            try:
                cached = _json.loads(cf.read_text())
                title  = cached.get("title") or cached.get("name") or cf.stem
                for ch in cached.get("chunks", []):
                    emb = ch.get("embedding")
                    if not emb:
                        continue
                    scored.append({
                        "doc":   title,
                        "page":  ch.get("page", "?"),
                        "text":  ch["text"][:600],
                        "score": cos(qe, emb),
                    })
            except Exception:
                continue

        scored.sort(key=lambda x: x["score"], reverse=True)
        return {
            "query":   query,
            "results": [{"doc": r["doc"], "page": r["page"], "text": r["text"]} for r in scored[:4]],
        }

    def _tool_get_damage_summary(self, args: dict) -> dict:
        """get_damage_summary() — aggregate building damage counts from the Moore datapack."""
        import json as _json  # noqa: PLC0415

        data_path = (
            _find_damage_classified()
        )
        if not data_path.is_file():
            return {"error": "Damage data not available — run /demo to load the Moore scenario."}

        counts: dict[str, int] = {}
        total = 0
        with data_path.open() as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    props = _json.loads(raw).get("properties") or {}
                    level = props.get("damage_level", "no-damage")
                    counts[level] = counts.get(level, 0) + 1
                    total += 1
                except Exception:
                    continue

        destroyed    = counts.get("destroyed", 0)
        major        = counts.get("major-damage", 0)
        return {
            "total_buildings_assessed": total,
            "damage_breakdown": {
                "no_damage":    counts.get("no-damage", 0),
                "minor_damage": counts.get("minor-damage", 0),
                "major_damage": major,
                "destroyed":    destroyed,
            },
            "major_or_destroyed": major + destroyed,
            "destroyed_pct":      round(destroyed / total * 100, 1) if total else 0,
            "incident_note": (
                "EF5 tornado, May 20 2013. 24 fatalities confirmed. "
                "Plaza Towers Elementary: 7 children killed."
            ),
        }

    def _tool_get_scenario_info(self, _args: dict) -> dict:
        """get_scenario_info() — current incident metadata and key locations."""
        return {
            "incident":      "Moore EF5 Tornado — May 20, 2013",
            "incident_id":   "MOORE-EF5-2013",
            "classification": "EF5 · winds >200 mph",
            "path":          "~17 miles WSW→ENE (Newcastle touchdown → SE Moore liftoff) · map shows ~5mi Moore urban core derived from building damage data",
            "peak_width_m":  2100,
            "duration_min":  39,
            "touchdown":     "3:16 PM CDT",
            "liftoff":       "3:55 PM CDT",
            "key_locations": [
                {"name": "Plaza Towers Elementary",  "lat": 35.32558, "lon": -97.50709, "note": "EF5 direct hit — 7 children killed"},
                {"name": "Briarwood Elementary",     "lat": 35.3210,  "lon": -97.4994,  "note": "EF5 direct hit"},
                {"name": "Moore Medical Center",     "lat": 35.3303,  "lon": -97.4780,  "note": "In tornado path — check operational status"},
                {"name": "Moore Fire Station 1 ICP", "lat": 35.3447,  "lon": -97.4800,  "note": "Primary ICP / staging area"},
                {"name": "Norman Regional Hospital", "lat": 35.2252,  "lon": -97.4185,  "note": "Level 2 trauma · 320 beds"},
                {"name": "OU Medical Center OKC",    "lat": 35.4983,  "lon": -97.4982,  "note": "Level 1 trauma · 700 beds"},
            ],
        }

    def _tool_list_resources(self, _args: dict) -> dict:
        """list_resources() — staged emergency resources at the ICP."""
        return {
            "icp": "Moore Fire Station 1",
            "resources": [
                {"type": "Search & Rescue",  "unit": "FEMA USAR OK-TF1",          "status": "deployed",   "location": "Plaza Towers sector"},
                {"type": "Search & Rescue",  "unit": "FEMA USAR TX-TF1",          "status": "en-route",   "eta_min": 45},
                {"type": "Medical",          "unit": "OSDH Mass Casualty Unit",   "status": "staged",     "location": "ICP"},
                {"type": "Medical",          "unit": "AMR Ambulance Strike (×8)", "status": "staged",     "location": "ICP"},
                {"type": "Law Enforcement",  "unit": "Moore PD + OHP",            "status": "deployed",   "location": "Perimeter"},
                {"type": "Public Works",     "unit": "Moore DPW heavy equipment", "status": "deployed",   "location": "19th St corridor"},
                {"type": "Shelter",          "unit": "Red Cross OKC Chapter",     "status": "activated",  "location": "Westmoore HS"},
                {"type": "National Guard",   "unit": "45th Infantry Bde OKARNG",  "status": "mobilizing", "eta_min": 120},
            ],
            "note": "Resource status at T+2hr post-impact (demo data).",
        }

    def _tool_geo_resolve_aoi(self, args: dict) -> dict:
        """geo_resolve_aoi(query?) — resolve a named area to coordinates + bbox.

        Returns the canonical Moore EF5 tornado AOI for any query that
        references Moore, OK or the active incident.
        """
        return {
            "aoi": "Moore, OK EF5 Tornado damage corridor",
            "center_lat": 35.332,
            "center_lon": -97.497,
            "bbox": {
                "lat_min": 35.295, "lat_max": 35.365,
                "lon_min": -97.535, "lon_max": -97.455,
            },
            "description": "3.1-mile wide EF5 track · 17 miles Newcastle → SE Moore (May 20, 2013)",
            "incident": "Moore EF5 Tornado 2013",
        }

    def _tool_odin_query_layer(self, args: dict) -> dict:
        """odin_tools.query_layer(layer, region?, limit?) — query Odin gold data."""
        import sys as _sys, importlib as _il  # noqa: PLC0415
        layer  = args.get("layer", "shelters")
        region = args.get("region")
        limit  = int(args.get("limit") or 10)
        # Try to import from severian-ollama sibling directory
        demo_dir = str(Path(__file__).resolve().parent.parent / "severian-ollama")
        if demo_dir not in _sys.path:
            _sys.path.insert(0, demo_dir)
        try:
            from odin_query_service import query_layer  # noqa: PLC0415
            return query_layer(layer, region=region, limit=limit)
        except Exception as e:
            return {"status": "error", "detail": str(e)}

    def _tool_find_closest(self, args: dict) -> dict:
        """find_closest(type, lat?, lon?) — nearest location of a given type.

        Args:
          type: one of hospital | shelter | staging | eoc | incident
          lat:  optional float — reference latitude  (defaults to incident center)
          lon:  optional float — reference longitude (defaults to incident center)

        Returns the closest matching location with name, coordinates, note,
        and straight-line distance in miles.
        """
        import math as _math  # noqa: PLC0415

        loc_type = (args.get("type") or "hospital").lower().strip()
        # Accept plural and common synonyms
        TYPE_ALIASES = {
            "hospitals": "hospital", "medical": "hospital", "trauma": "hospital",
            "shelters":  "shelter",  "refuge":  "shelter",
            "staging":   "staging",  "icp":     "staging",  "command": "staging",
            "eoc":       "eoc",      "eocc":    "eoc",
            "incident":  "incident", "impact":  "incident",
        }
        loc_type = TYPE_ALIASES.get(loc_type, loc_type)

        # All known scenario locations (mirrors config.js LOCATIONS)
        ALL_LOCATIONS = [
            {"name": "Plaza Towers Elementary",  "lat": 35.32558, "lon": -97.50709, "type": "incident", "note": "EF5 direct hit — 7 children killed"},
            {"name": "Briarwood Elementary",     "lat": 35.3210,  "lon": -97.4994,  "type": "incident", "note": "EF5 direct hit"},
            {"name": "Moore Medical Center",     "lat": 35.3303,  "lon": -97.4780,  "type": "hospital", "note": "In tornado path — check operational status"},
            {"name": "Moore Fire Station 1 ICP", "lat": 35.3447,  "lon": -97.4800,  "type": "staging",  "note": "Primary ICP / staging area"},
            {"name": "Moore City Hall EOC",      "lat": 35.3372,  "lon": -97.4868,  "type": "eoc",      "note": "City EOC — activated"},
            {"name": "Westmoore High School",    "lat": 35.3087,  "lon": -97.5122,  "type": "shelter",  "note": "Red Cross shelter / potential staging"},
            {"name": "Norman Regional Hospital", "lat": 35.2252,  "lon": -97.4185,  "type": "hospital", "note": "Level 2 trauma · 320 beds · 8mi south"},
            {"name": "OU Medical Center OKC",    "lat": 35.4983,  "lon": -97.4982,  "type": "hospital", "note": "Level 1 trauma · 700 beds · 12mi north"},
            {"name": "Warren Theatre Moore",     "lat": 35.3383,  "lon": -97.4868,  "type": "staging",  "note": "Landmark / reference point"},
        ]

        # Incident center as default reference point
        ref_lat = float(args.get("lat") or 35.332)
        ref_lon = float(args.get("lon") or -97.497)

        def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
            R = 3958.8  # Earth radius miles
            phi1, phi2 = _math.radians(lat1), _math.radians(lat2)
            dphi = _math.radians(lat2 - lat1)
            dlam = _math.radians(lon2 - lon1)
            a = _math.sin(dphi / 2) ** 2 + _math.cos(phi1) * _math.cos(phi2) * _math.sin(dlam / 2) ** 2
            return 2 * R * _math.asin(_math.sqrt(a))

        candidates = [loc for loc in ALL_LOCATIONS if loc["type"] == loc_type]
        if not candidates:
            return {
                "error": f"No locations of type '{loc_type}' in scenario data.",
                "valid_types": ["hospital", "shelter", "staging", "eoc", "incident"],
            }

        ranked = sorted(candidates, key=lambda l: haversine_mi(ref_lat, ref_lon, l["lat"], l["lon"]))
        results = []
        for loc in ranked[:3]:
            dist = haversine_mi(ref_lat, ref_lon, loc["lat"], loc["lon"])
            results.append({
                "name":     loc["name"],
                "lat":      loc["lat"],
                "lon":      loc["lon"],
                "note":     loc["note"],
                "distance_mi": round(dist, 1),
            })

        return {
            "type":      loc_type,
            "reference": {"lat": ref_lat, "lon": ref_lon},
            "closest":   results[0],
            "all_nearby": results,
        }

    # ── Demo scenario loader ───────────────────────────────────────────
    def _demo_reset(self) -> None:
        """POST /demo/reset — wipe all server-side session state for a fresh demo.

        Clears:
          • data/chain.jsonl   (VPO provenance chain)
          • data/chat-log/     (signed turn envelopes)
          • data/document-cache/ (PDF chunk embeddings — rebuilt on next upload)
          • Artifact dirs (/tmp/severian-charts/, /tmp/te-viz/, /tmp/severian-maps/, /tmp/severian-uploads/)
          • Mem0 memory (Qdrant severian_chat collection)

        Non-destructive: library PDFs and MBTiles are untouched.
        """
        import json as _json  # noqa: PLC0415

        cleared = []

        # VPO chain
        try:
            _chain_log_path().write_text("")
            cleared.append("chain.jsonl")
        except Exception as exc:
            cleared.append(f"chain.jsonl(ERR:{exc})")

        # Chat turn log
        try:
            for f in _chat_log_dir().glob("*.json"):
                f.unlink()
            cleared.append("chat-log/")
        except Exception as exc:
            cleared.append(f"chat-log/(ERR:{exc})")

        # Document cache
        try:
            for f in DOCUMENT_CACHE_DIR.glob("*.json"):
                f.unlink()
            cleared.append("document-cache/")
        except Exception as exc:
            cleared.append(f"document-cache/(ERR:{exc})")

        # Artifact dirs — clear so _demo_load re-seeds a clean set
        for kind, root in ARTIFACT_DIRS.items():
            try:
                for f in root.glob("*"):
                    if f.is_file() and f.suffix.lower() in ARTIFACT_EXTS:
                        f.unlink()
                cleared.append(f"{kind}/")
            except Exception as exc:
                cleared.append(f"{kind}/(ERR:{exc})")

        # Mem0 memory
        mem = _get_memory()
        if mem is not None:
            try:
                mem.reset()
                cleared.append("mem0")
            except Exception as exc:
                cleared.append(f"mem0(ERR:{exc})")

        out = _json.dumps({"status": "ok", "cleared": cleared}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    def _demo_load(self) -> None:
        """POST /demo/load — seed the Moore EF5 Tornado 2013 scenario.

        Seeds the harness incident (non-fatal if harness not running) and
        returns the scenario metadata card so app.js can render it and arm
        the demo-active state.
        """
        import json as _json          # noqa: PLC0415
        import shutil as _shutil      # noqa: PLC0415
        import urllib.request as _ur  # noqa: PLC0415

        # Seed demo artifacts so the Artifacts tab is pre-populated on /demo load.
        # Source PNGs live in DEMOS/MOORE_TORNADO/ relative to this file.
        _moore = Path(__file__).resolve().parents[1] / "MOORE_TORNADO"
        _seed_map: list[tuple[Path, str, str]] = [
            (_moore / "nws_norman_2013_storm_survey.png",  "map",   "nws-storm-survey-2013.png"),
            (_moore / "output" / "damage_assessment.png",  "chart", "damage-assessment-moore.png"),
            (_moore / "building_exploration.png",          "viz",   "building-damage-viz.png"),
        ]
        for src, kind, dest_name in _seed_map:
            if not src.exists():
                continue
            dest_dir = ARTIFACT_DIRS.get(kind)
            if dest_dir is None:
                continue
            dest_dir.mkdir(parents=True, exist_ok=True)
            try:
                _shutil.copy2(src, dest_dir / dest_name)
            except Exception:
                pass  # non-fatal — artifacts tab will just stay empty

        harness_status = "not_running"
        try:
            body = _json.dumps({
                "name": "Moore EF5 Tornado 2013",
                "incident_id": "moore-tornado-2013",
                "incident_type": "tornado",
                "severity": "catastrophic",
                "location": "Moore, Oklahoma",
                "ic_name": None,
            }).encode()
            req = _ur.Request(
                "http://localhost:8888/api/v1/incidents",
                data=body,
                headers={"Content-Type": "application/json"},
            )
            with _ur.urlopen(req, timeout=5) as r:
                harness_status = "seeded" if r.status in (200, 201) else f"http_{r.status}"
        except Exception:
            harness_status = "offline"

        scenario = {
            "incident_id": "moore-tornado-2013",
            "incident_name": "Moore EF5 Tornado 2013",
            "location": "Moore, Oklahoma",
            "date": "May 20, 2013 at 15:01 CDT",
            "track": "~5mi shown (Moore urban core) · full NWS track ~17mi Newcastle→SE Moore · EF5 · peak width 2,100m",
            "damage": "927 destroyed · 16,968 total assessed (5.5% destroyed)",
            "critical_nodes": [
                {"name": "Plaza Towers Elementary", "lat": 35.325, "lon": -97.488,
                 "note": "EF5 direct hit — children trapped"},
                {"name": "Moore Medical Center", "lat": 35.330, "lon": -97.478,
                 "note": "In tornado path — facility may be offline"},
            ],
            "harness_status": harness_status,
            "hint": "Say \"I'm Chief Martinez, Moore FD. I am arriving on scene.\" to begin.",
        }

        out = _json.dumps({"status": "ok", "scenario": scenario}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    def _demo_damage(self) -> None:
        """GET /demo/damage — building damage data for the COP map overlay.

        Returns two payloads:
          heatmap: [[lat, lng, intensity], ...] for all buildings (L.heatLayer input)
          track:   GeoJSON FeatureCollection of major-damage + destroyed polygons only
        """
        import json as _json  # noqa: PLC0415

        data_path = (
            _find_damage_classified()
        )

        INTENSITY = {
            "no-damage":     0.10,
            "minor-damage":  0.40,
            "major-damage":  0.75,
            "destroyed":     1.00,
        }
        TRACK_LEVELS = {"major-damage", "destroyed"}

        heatmap: list = []
        track_features: list = []

        if data_path.is_file():
            with data_path.open() as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        feat = _json.loads(raw)
                    except _json.JSONDecodeError:
                        continue
                    props = feat.get("properties") or {}
                    level = props.get("damage_level", "no-damage")
                    lat = props.get("lat")
                    lon = props.get("lon")
                    if lat is None or lon is None:
                        continue
                    heatmap.append([lat, lon, INTENSITY.get(level, 0.1)])
                    if level in TRACK_LEVELS:
                        track_features.append({
                            "type": "Feature",
                            "geometry": feat.get("geometry"),
                            "properties": {"damage_level": level},
                        })

        out = _json.dumps({
            "heatmap": heatmap,
            "track": {"type": "FeatureCollection", "features": track_features},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    def _demo_track(self) -> None:
        """GET /demo/track — Moore EF5 tornado track as GeoJSON.

        Returns two features:
          - Polygon: approximate damage swath (NWS survey path, peak width 2,100m)
          - LineString: centerline of the track
        Coordinates derived from NOAA/NWS Norman damage survey, May 20 2013.
        """
        import json as _json  # noqa: PLC0415

        # Centerline derived from actual damage_classified.geojsonl building centroids.
        # Track runs W→E through Moore with a slight northward trend.
        centerline = [
            [-97.5350, 35.3190],
            [-97.5251, 35.3199],
            [-97.5175, 35.3224],
            [-97.5128, 35.3231],
            [-97.5082, 35.3242],
            [-97.5034, 35.3260],
            [-97.4932, 35.3304],
            [-97.4755, 35.3311],
            [-97.4586, 35.3332],
            [-97.4450, 35.3340],
        ]

        # Damage swath polygon — north edge W→E, south edge E→W, then close.
        # Edges computed from per-longitude lat_min/lat_max of damaged buildings,
        # extended slightly beyond the data bounds on both sides.
        swath_north = [
            [-97.5350, 35.3240],
            [-97.5251, 35.3273],
            [-97.5175, 35.3269],
            [-97.5128, 35.3285],
            [-97.5082, 35.3298],
            [-97.5034, 35.3434],
            [-97.4932, 35.3453],
            [-97.4755, 35.3364],
            [-97.4586, 35.3416],
            [-97.4450, 35.3420],
        ]
        swath_south = [
            [-97.4450, 35.3250],
            [-97.4586, 35.3303],
            [-97.4755, 35.3179],
            [-97.4932, 35.3237],
            [-97.5034, 35.3177],
            [-97.5082, 35.3163],
            [-97.5128, 35.3122],
            [-97.5175, 35.3122],
            [-97.5251, 35.3125],
            [-97.5350, 35.3140],
        ]
        swath_coords = swath_north + swath_south + [swath_north[0]]

        track = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": [swath_coords]},
                    "properties": {
                        "name": "Moore EF5 Damage Swath",
                        "ef_scale": 5,
                        "width_m": 2100,
                        "length_mi": 8,
                        "date": "2013-05-20",
                        "note": "Extent matches xView2 damage assessment coverage",
                    },
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": centerline},
                    "properties": {"name": "Tornado Centerline", "ef_scale": 5},
                },
            ],
        }

        out = _json.dumps(track).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    def _demo_buildings(self) -> None:
        """GET /demo/buildings — damage-classified building footprints (peer model).

        16,968 building polygons coloured by xView2 damage level:
        no-damage / minor-damage / major-damage / destroyed.
        Returns stripped GeoJSON (geometry + damage_level + area_m2) for performance.
        """
        import json as _json  # noqa: PLC0415

        data_path = (
            _find_damage_classified()
        )

        features: list = []
        if data_path.is_file():
            with data_path.open() as fh:
                for raw in fh:
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        feat = _json.loads(raw)
                    except _json.JSONDecodeError:
                        continue
                    props = feat.get("properties") or {}
                    level = props.get("damage_level", "no-damage")
                    if level not in {"destroyed", "major-damage", "minor-damage"}:
                        continue
                    features.append({
                        "type": "Feature",
                        "geometry": feat.get("geometry"),
                        "properties": {
                            "damage_level": level,
                            "area_m2":      props.get("area_m2"),
                        },
                    })

        out = _json.dumps({"type": "FeatureCollection", "features": features}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    # ── Session memory (Mem0 + Qdrant, shared with CLI chat.py) ─────
    def _memory_add(self) -> None:
        """POST /memory/add  body: {question, answer}
        Stores the Q/A pair in the shared Mem0+Qdrant store.
        """
        import json as _json  # noqa: PLC0415
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        req = _json.loads(raw) if raw else {}

        mem = _get_memory()
        if mem is None:
            body = _json.dumps({"enabled": False, "status": "memory_unavailable"}).encode()
        else:
            try:
                question = str(req.get("question", ""))
                answer   = str(req.get("answer", ""))
                mem.add(question, answer)
                body = _json.dumps({"status": "ok"}).encode()
            except Exception as exc:
                body = _json.dumps({"status": "error", "detail": str(exc)[:120]}).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _memory_context(self) -> None:
        """POST /memory/context  body: {query, k?}
        Returns relevant prior-turn context to inject before the LLM call.
        """
        import json as _json  # noqa: PLC0415
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        req = _json.loads(raw) if raw else {}

        mem = _get_memory()
        if mem is None:
            body = _json.dumps({"enabled": False, "has_context": False, "context": ""}).encode()
        else:
            try:
                query = str(req.get("query", ""))
                k = int(req.get("k", 5))
                ctx = mem.context_block(query, k=k)
                body = _json.dumps({
                    "has_context": bool(ctx),
                    "context": ctx or "",
                }).encode()
            except Exception as exc:
                body = _json.dumps({"has_context": False, "context": "",
                                    "detail": str(exc)[:120]}).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _memory_list(self) -> None:
        """GET /memory/list — returns all stored memories for this IC."""
        import json as _json  # noqa: PLC0415
        mem = _get_memory()
        if mem is None:
            body = _json.dumps({"enabled": False, "memories": []}).encode()
        else:
            try:
                memories = mem.all()
                body = _json.dumps({"memories": memories}).encode()
            except Exception as exc:
                body = _json.dumps({"memories": [], "detail": str(exc)[:120]}).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _memory_clear(self) -> None:
        """GET /memory/clear — wipes all memories for this IC (irreversible)."""
        import json as _json  # noqa: PLC0415
        mem = _get_memory()
        if mem is None:
            body = _json.dumps({"enabled": False, "status": "memory_unavailable"}).encode()
        else:
            try:
                mem.reset()
                body = _json.dumps({"status": "ok"}).encode()
            except Exception as exc:
                body = _json.dumps({"status": "error", "detail": str(exc)[:120]}).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _memory_status(self) -> None:
        """GET /memory/status — reports whether Mem0 is available."""
        import json as _json  # noqa: PLC0415
        mem = _get_memory()
        user_id = None
        if mem is not None:
            try:
                from severian_memory import _MEMORY_USER_ID  # type: ignore[import]
                user_id = _MEMORY_USER_ID
            except Exception:
                user_id = "ic_default"
        body = _json.dumps({
            "enabled": mem is not None,
            "user_id": user_id,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── Status / health check ─────────────────────────────────────────
    def _serve_status(self) -> None:
        """GET /status → JSON health summary mirroring the CLI boot banner.

        Probes the same subsystems as chat.py _health_check():
          Ollama daemon, model loaded, Doctrine RAG, Chat memory, TTS.
        Returns each as {label, status("ok"|"warn"|"fail"), detail}.
        The web boot banner reads this to render the ● health panel.
        """
        import json as _json          # noqa: PLC0415
        import urllib.request as _ur  # noqa: PLC0415

        ollama_base = EMBED_OLLAMA_URL  # tunnelled Ollama (same origin as embeddings)

        def _probe_ollama() -> tuple[str, str]:
            for candidate in [ollama_base, "http://127.0.0.1:11434"]:
                try:
                    with _ur.urlopen(f"{candidate}/api/tags", timeout=2) as r:
                        if r.status == 200:
                            return ("ok", candidate)
                except Exception:
                    pass
            return ("fail", "not reachable on :11500 or :11434")

        def _probe_model() -> tuple[str, str]:
            for candidate in [ollama_base, "http://127.0.0.1:11434"]:
                try:
                    with _ur.urlopen(f"{candidate}/api/tags", timeout=2) as r:
                        if r.status == 200:
                            import json as _j  # noqa: PLC0415
                            data = _j.loads(r.read())
                            for m in data.get("models", []):
                                name = m.get("name") or m.get("model") or ""
                                if name.startswith("severian-ollama"):
                                    return ("ok", f"loaded ({name})")
                            return ("warn", "severian-ollama not in model list")
                except Exception:
                    pass
            return ("fail", "Ollama unreachable")

        def _probe_rag() -> tuple[str, str]:
            # parents[2] = repo root (works for both main checkout and worktree)
            _repo = Path(__file__).resolve().parents[2]
            candidates = [
                Path("chunks.db"),
                Path("data/chunks.db"),
                Path.home() / ".severian" / "chunks.db",
                Path(__file__).parent.parent / "severian-ollama" / "chunks.db",
                _repo / "python" / "packages" / "te-formalize" / "store" / "chunks.db",
                # chunks.db is untracked — only in main checkout, not worktrees
                Path.home() / "AI" / "TERMINUSEST-AI" / "python" / "packages" / "te-formalize" / "store" / "chunks.db",
                Path.home() / "AI" / "TERMINUSEST-AI" / "DIVISIONS" / "NIMS" / "SEVERIAN" / "DOCTRINE" / "NIMS" / "chunks.db",
                Path(__file__).parent.parent / "severian-ollama" / "chunks.db",
            ]
            for c in candidates:
                if c.is_file():
                    size_mb = c.stat().st_size / 1_000_000
                    return ("ok", f"{c.name} ({size_mb:.1f} MB)")
            return ("warn", "chunks.db not found — RAG disabled")

        def _probe_memory() -> tuple[str, str]:
            qdrant = Path.home() / ".severian" / "chats" / "qdrant"
            if qdrant.exists():
                return ("ok", "qdrant + history.db")
            return ("warn", "Mem0 will lazy-init on first turn")

        def _probe_tts() -> tuple[str, str]:
            onnx_dir = Path.home() / ".severian" / "voices"
            voice = "en_GB-alan-medium"
            if (onnx_dir / f"{voice}.onnx").exists():
                return ("ok", f"Piper {voice} (offline)")
            return ("warn", "Piper voice not cached — TTS disabled")

        checks_fns = [
            ("Ollama daemon",   _probe_ollama),
            ("severian-ollama", _probe_model),
            ("Doctrine RAG",    _probe_rag),
            ("Chat memory",     _probe_memory),
            ("TTS",             _probe_tts),
        ]
        checks = []
        for label, fn in checks_fns:
            try:
                status, detail = fn()
            except Exception as exc:
                status, detail = "fail", f"probe error: {exc}"
            checks.append({"label": label, "status": status, "detail": detail})

        body = _json.dumps({
            "mode": f"API :{self.server.server_address[1]}",
            "rag": "on",
            "top_k": 5,
            "model": "TE NIMS (stage10)",
            "checks": checks,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── Library (read-only NIMS doctrine PDF corpus) ─────────────────
    def _list_library(self) -> None:
        """GET /library → JSON list of every PDF in LIBRARY_DIR.

        Each entry: {name, size, mtime, mtime_iso, category, title}.
        category = NIMS|NRF|ESF|ICS|OTHER (parsed from filename prefix)
        title = filename without extension, with dashes replaced for
                friendlier display in the UI.
        """
        import datetime as _dt  # noqa: PLC0415
        import json as _json    # noqa: PLC0415
        items: list[dict] = []
        if LIBRARY_DIR.is_dir():
            for p in sorted(LIBRARY_DIR.iterdir()):
                if p.suffix.lower() != ".pdf" or not p.is_file():
                    continue
                try:
                    st = p.stat()
                except OSError:
                    continue
                stem = p.stem
                lower = stem.lower()
                # Category by filename prefix. Order matters — check the
                # more-specific prefixes (NRF-Support-Annex, FEMA-NIMS)
                # before the parent (NRF, FEMA).
                if lower.startswith("nrf-support-annex"):
                    category = "NRF Support Annex"
                elif lower.startswith("fema-nims"):
                    category = "NIMS Doctrine"
                elif lower.startswith("fema-nrf"):
                    category = "National Response Framework"
                elif lower.startswith("esf-"):
                    category = "Emergency Support Functions"
                elif lower.startswith("ics-"):
                    category = "ICS Forms"
                else:
                    category = "Other"
                if category == "ICS Forms":
                    continue
                items.append({
                    "name": p.name,
                    "title": stem.replace("-", " "),
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "mtime_iso": _dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                    "category": category,
                })
        body = _json.dumps({"count": len(items), "items": items}, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── ICS Forms (grouped by form number) ───────────────────────────
    def _list_ics_forms(self) -> None:
        """GET /ics-forms → JSON list of ICS form PDFs grouped by form number.

        Each group: {number, label, current: {name, title, size, mtime,
        mtime_iso}, prior_versions: []}.  Groups sorted by label
        (ICS-201, ICS-202, …, ICS-213RR, ICS-215A, …).
        """
        import datetime as _dt  # noqa: PLC0415
        import json as _json    # noqa: PLC0415
        import re as _re        # noqa: PLC0415

        # Map form number → list of file stat dicts (for multi-version support)
        groups: dict[str, list[dict]] = {}

        def _scan_dir(directory: Path, is_archive: bool) -> None:
            if not directory.is_dir():
                return
            for p in directory.iterdir():
                if p.suffix.lower() != ".pdf" or not p.is_file():
                    continue
                if not p.name.lower().startswith("ics-"):
                    continue
                m = _re.search(r"ICS-(\d{3}[A-Z0-9]*)", p.name, _re.IGNORECASE)
                if not m:
                    continue
                number = m.group(1).upper()
                try:
                    st = p.stat()
                except OSError:
                    continue
                stem = p.stem  # e.g. "ICS-201-Incident-Briefing" or "…_20260514-080624"
                # Strip timestamp suffix from archived copies so the title reads cleanly.
                clean_stem = _re.sub(r"_\d{8}-\d{6}$", "", stem)
                title_part = _re.sub(
                    r"^ICS-\d{3}[A-Z0-9]*-?", "", clean_stem, flags=_re.IGNORECASE
                ).replace("-", " ").title()
                entry = {
                    "name": p.name,
                    "title": title_part,
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "mtime_iso": _dt.datetime.fromtimestamp(st.st_mtime).isoformat(
                        timespec="seconds"
                    ),
                    "archived": is_archive,
                }
                groups.setdefault(number, []).append(entry)

        _scan_dir(LIBRARY_DIR, is_archive=False)
        _scan_dir(SAVED_FORMS_DIR, is_archive=True)

        forms: list[dict] = []
        for number, versions in groups.items():
            # Newest file (by mtime) across both dirs is always current.
            versions.sort(key=lambda e: e["mtime"], reverse=True)
            forms.append({
                "number": number,
                "label": f"ICS-{number}",
                "current": versions[0],
                "prior_versions": versions[1:],
            })

        # Sort groups by label alphabetically
        forms.sort(key=lambda g: g["label"])

        body = _json.dumps({"count": len(forms), "forms": forms}, indent=2).encode(
            "utf-8"
        )
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _odin_layers(self) -> None:
        """GET /api/odin/layers → Odin gold layer stats for the Data tab."""
        import json as _json  # noqa: PLC0415

        gold_dir = (
            Path(__file__).resolve().parent.parent
            / "severian-ollama" / "data" / "odin" / "gold" / "okc"
        )

        LAYER_DESC = {
            "shelters":               "Emergency shelters and Red Cross facilities",
            "hospitals":              "Hospitals and public health facilities",
            "fire_stations":          "Fire stations and rescue units",
            "emergency_services":     "Law enforcement, EMS, and emergency management",
            "utilities":              "Power generation, substations, and critical utilities",
            "vulnerable_populations": "Electricity-dependent residents and high social-vulnerability tracts",
            "transit":                "Public transit stops (Embark OKC bus network)",
        }
        STATIC_COUNTS = {
            "shelters": 257, "hospitals": 312, "fire_stations": 78,
            "emergency_services": 160, "utilities": 168,
            "vulnerable_populations": 67, "transit": 1421,
        }

        layers = []
        total = 0
        built_at = "2026-05-12"

        if gold_dir.exists():
            meta_path = gold_dir / "metadata.json"
            if meta_path.exists():
                try:
                    meta = _json.loads(meta_path.read_text())
                    built_at = meta.get("built_at", built_at)[:10]
                except Exception:
                    pass
            try:
                import pandas as _pd  # noqa: PLC0415
                for name, desc in LAYER_DESC.items():
                    p = gold_dir / f"{name}.parquet"
                    if p.exists():
                        count = len(_pd.read_parquet(p))
                    else:
                        count = STATIC_COUNTS.get(name, 0)
                    layers.append({"name": name, "description": desc, "count": count, "status": "ready"})
                    total += count
            except Exception:
                pass

        if not layers:
            for name, desc in LAYER_DESC.items():
                count = STATIC_COUNTS[name]
                layers.append({"name": name, "description": desc, "count": count, "status": "ready"})
                total += count

        result = {
            "status": "ok",
            "built_at": built_at,
            "coverage": "OKC/Moore Metro (35.0–35.65°N, 97.0–97.85°W)",
            "total_records": total,
            "layers": layers,
        }
        body = _json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_library_pdf(self, name: str) -> None:
        """GET /library/<name>.pdf → the raw PDF bytes, served inline so
        the browser's PDF viewer renders it (Content-Disposition: inline).

        Path safety: name must contain no slashes and must resolve under
        LIBRARY_DIR (no `..` escape). Read-only — no upload endpoint yet.
        """
        if "/" in name or "\\" in name or name.startswith("..") or not name.endswith(".pdf"):
            self.send_error(400, "invalid library filename")
            return
        # Check canonical LIBRARY_DIR first; fall back to SAVED_FORMS_DIR for
        # archived prior versions (timestamped filenames).
        path = (LIBRARY_DIR / name).resolve()
        try:
            path.relative_to(LIBRARY_DIR.resolve())
        except ValueError:
            self.send_error(400, "library path escapes its root")
            return
        if not path.is_file():
            path = (SAVED_FORMS_DIR / name).resolve()
            try:
                path.relative_to(SAVED_FORMS_DIR.resolve())
            except ValueError:
                self.send_error(400, "library path escapes its root")
                return
        if not path.is_file():
            self.send_error(404, "library doc not found")
            return
        try:
            data = path.read_bytes()
        except OSError as e:
            self.send_error(500, f"read failed: {e}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'inline; filename="{name}"')
        # PDFs are immutable doctrine corpus — cache aggressively (the
        # client-side disk cache for these is fine; the no-cache rule in
        # end_headers() only applies to .html/.js/.css/.json).
        self.send_header("Cache-Control", "public, max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def _reset_ics_forms(self) -> None:
        """POST /ics-forms/reset — delete all versioned copies in SAVED_FORMS_DIR.

        Leaves LIBRARY_DIR untouched (canonical originals stay).  Called by
        the /reload slash command to return forms to their factory state.
        """
        import json as _json  # noqa: PLC0415
        deleted = []
        if SAVED_FORMS_DIR.is_dir():
            for p in SAVED_FORMS_DIR.iterdir():
                if p.suffix.lower() == ".pdf" and p.is_file():
                    try:
                        p.unlink()
                        deleted.append(p.name)
                    except OSError:
                        pass
        out = _json.dumps({"ok": True, "deleted": len(deleted)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    def _open_ics_form_native(self) -> None:
        """GET /ics-forms/open?name=<filename>

        Opens the PDF with the OS default application (Preview on macOS,
        xdg-open on Linux).  Only meaningful when serve.py runs on the same
        machine as the browser (single-operator FOB / thumbdrive scenario).
        """
        import json as _json  # noqa: PLC0415
        import subprocess  # noqa: PLC0415
        from urllib.parse import urlparse, parse_qs  # noqa: PLC0415

        qs = parse_qs(urlparse(self.path).query)
        name = (qs.get("name", [""])[0]).strip()
        if not name or "/" in name or "\\" in name or not name.lower().endswith(".pdf"):
            self.send_error(400, "invalid filename")
            return
        path = (LIBRARY_DIR / name).resolve()
        if not path.is_file():
            path = (SAVED_FORMS_DIR / name).resolve()
        if not path.is_file():
            self.send_error(404, "file not found")
            return
        # In cloud/remote deployments (no local desktop) serve the PDF inline
        # so the browser opens it in a new tab. Falls back to native open only
        # when serve.py is running on the same machine as the browser.
        is_local = self.server.server_address[0] in ("127.0.0.1", "localhost", "::1") or \
                   self.headers.get("host", "").startswith("localhost")
        if is_local:
            try:
                if sys.platform == "darwin":
                    subprocess.Popen(["open", str(path)])
                elif sys.platform.startswith("linux"):
                    subprocess.Popen(["xdg-open", str(path)])
                else:
                    subprocess.Popen(["start", "", str(path)], shell=True)  # noqa: S602
            except Exception:
                pass  # fall through to browser delivery below
        # Serve PDF inline — browser opens in new tab (works for remote deployments)
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f"inline; filename=\"{name}\"")
        self.end_headers()
        self.wfile.write(data)

    def _save_ics_form(self) -> None:
        """POST /ics-forms/save?name=<filename>  (no body)

        One-click versioned save: copies the named PDF (from LIBRARY_DIR or
        SAVED_FORMS_DIR) into SAVED_FORMS_DIR with a fresh timestamp suffix.
        The newest file in SAVED_FORMS_DIR for a given ICS number is always
        treated as current by /ics-forms.

        Filename produced: <base-stem>_YYYYMMDD-HHMMSS.pdf
        (any existing timestamp suffix is stripped so names stay clean).
        """
        import json as _json  # noqa: PLC0415
        import re as _re  # noqa: PLC0415
        from datetime import datetime  # noqa: PLC0415
        from urllib.parse import urlparse, parse_qs  # noqa: PLC0415

        qs = parse_qs(urlparse(self.path).query)
        name = (qs.get("name", [""])[0]).strip()
        if not name or "/" in name or "\\" in name or not name.lower().endswith(".pdf"):
            self.send_error(400, "invalid filename")
            return

        # Find source — check LIBRARY_DIR then SAVED_FORMS_DIR.
        src = (LIBRARY_DIR / name).resolve()
        if not src.is_file():
            src = (SAVED_FORMS_DIR / name).resolve()
        if not src.is_file():
            self.send_error(404, "file not found in library or saved-forms")
            return

        # Strip any existing _YYYYMMDD-HHMMSS suffix so names stay clean.
        base_stem = _re.sub(r"_\d{8}-\d{6}$", "", src.stem)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = SAVED_FORMS_DIR / f"{base_stem}_{ts}.pdf"
        try:
            pdf_bytes = src.read_bytes()
            dest.write_bytes(pdf_bytes)
        except OSError as e:
            self.send_error(500, f"write failed: {e}")
            return

        pdf_url = f"/library/{dest.name}"
        vpo_block = _append_vpo_for_pdf_save(dest.name, pdf_bytes)
        resp: dict = {"ok": True, "saved_as": dest.name, "pdf_url": pdf_url}
        if vpo_block:
            resp["vpo_block_hash"] = vpo_block["block_hash"]

        out = _json.dumps(resp).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    # ── Document RAG (drag a Library PDF into chat → grounded reply) ──
    def _document_prepare(self) -> None:
        """POST /document/prepare → body {"name": "<library-pdf-name>.pdf"}.

        Extracts text from LIBRARY_DIR/<name>, chunks it, embeds each chunk
        via Ollama nomic-embed-text, caches the result on disk for fast
        re-use. Idempotent: identical (name, mtime) returns the cached
        doc_id instantly. Slow first call for big PDFs (FEMA NIMS doctrine
        ~30-60s), sub-second for ICS forms.

        Returns {"doc_id": "<sha256>", "chunks": N, "title": "<name>"}.
        """
        import hashlib as _hashlib  # noqa: PLC0415
        import json as _json        # noqa: PLC0415
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            req = _json.loads(raw) if raw else {}
        except Exception as e:
            self.send_error(400, f"bad request body: {e}")
            return

        name = req.get("name", "").strip()
        if not name or "/" in name or "\\" in name or not name.endswith(".pdf"):
            self.send_error(400, "name must be a *.pdf basename")
            return
        path = (LIBRARY_DIR / name).resolve()
        try:
            path.relative_to(LIBRARY_DIR.resolve())
        except ValueError:
            self.send_error(400, "path escapes LIBRARY_DIR")
            return
        if not path.is_file():
            self.send_error(404, "library doc not found")
            return

        # doc_id keyed off content sha so re-uploaded variants get fresh cache
        st = path.stat()
        sha = _hashlib.sha256()
        sha.update(name.encode("utf-8"))
        sha.update(str(st.st_mtime_ns).encode("utf-8"))
        sha.update(str(st.st_size).encode("utf-8"))
        doc_id = sha.hexdigest()

        DOCUMENT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_path = DOCUMENT_CACHE_DIR / f"{doc_id}.json"
        if cache_path.exists():
            cached = _json.loads(cache_path.read_text())
            body = _json.dumps({
                "doc_id": doc_id,
                "chunks": len(cached.get("chunks", [])),
                "title":  cached.get("title", name),
                "cached": True,
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        # Cache miss — extract + chunk + embed
        try:
            chunks = self._extract_and_chunk_pdf(path)
        except Exception as e:
            self.send_error(500, f"pdf extract failed: {e}")
            return

        try:
            embeddings = self._embed_chunks(chunks)
        except Exception as e:
            self.send_error(500, f"embed failed: {e}")
            return

        cache = {
            "doc_id":  doc_id,
            "title":   path.stem.replace("-", " "),
            "name":    name,
            "chunks":  [{"text": c["text"], "page": c["page"], "embedding": emb}
                        for c, emb in zip(chunks, embeddings)],
        }
        cache_path.write_text(_json.dumps(cache))

        body = _json.dumps({
            "doc_id": doc_id,
            "chunks": len(chunks),
            "title":  cache["title"],
            "cached": False,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _extract_and_chunk_pdf(self, path: Path) -> list[dict]:
        """Read text page-by-page via pypdfium2, then split into rolling
        ~DOC_MAX_CHARS chunks with DOC_CHUNK_OVERLAP*4 char overlap. Each
        chunk is tagged with the source page (first page of its content)."""
        import pypdfium2 as pdfium  # noqa: PLC0415
        pdf = pdfium.PdfDocument(str(path))
        pages_text: list[tuple[int, str]] = []
        for i, page in enumerate(pdf):
            text_page = page.get_textpage()
            t = text_page.get_text_range().strip()
            text_page.close()
            page.close()
            if t:
                pages_text.append((i + 1, t))
        pdf.close()

        # Rolling chunker that respects page boundaries — each chunk records
        # the first page it draws from. For multi-page PDFs the chunk may
        # straddle pages; we emit the starting page only (good enough for
        # IC reference).
        chunks: list[dict] = []
        buf = ""
        buf_page = 1
        for page_no, text in pages_text:
            for paragraph in text.split("\n\n"):
                p = paragraph.strip()
                if not p:
                    continue
                if not buf:
                    buf_page = page_no
                buf += " " + p
                while len(buf) >= DOC_MAX_CHARS:
                    chunks.append({"text": buf[:DOC_MAX_CHARS], "page": buf_page})
                    overlap_chars = DOC_CHUNK_OVERLAP * 4
                    buf = buf[DOC_MAX_CHARS - overlap_chars:]
                    buf_page = page_no
        if buf.strip():
            chunks.append({"text": buf.strip(), "page": buf_page})
        return chunks

    def _embed_chunks(self, chunks: list[dict]) -> list[list[float]]:
        """Embed each chunk via Ollama nomic-embed-text. Sequential — small
        gains from parallelizing not worth the complexity for a one-shot
        prepare. ~30-50ms per chunk on Studio."""
        import json as _json        # noqa: PLC0415
        import urllib.request as _ur  # noqa: PLC0415
        out: list[list[float]] = []
        for c in chunks:
            payload = _json.dumps({"model": EMBED_MODEL, "prompt": c["text"]}).encode("utf-8")
            req = _ur.Request(
                f"{EMBED_OLLAMA_URL}/api/embeddings",
                data=payload,
                headers={"Content-Type": "application/json"},
            )
            with _ur.urlopen(req, timeout=30) as resp:
                data = _json.loads(resp.read().decode("utf-8"))
            emb = data.get("embedding", [])
            if not emb:
                raise RuntimeError(f"empty embedding for chunk page={c['page']}")
            out.append(emb)
        return out

    def _document_query(self) -> None:
        """POST /document/query → {"doc_id": ..., "query": ..., "k": 4}.
        Returns top-k chunks by cosine similarity, each with score + page."""
        import json as _json        # noqa: PLC0415
        import math as _math        # noqa: PLC0415
        import urllib.request as _ur  # noqa: PLC0415
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            req = _json.loads(raw) if raw else {}
        except Exception as e:
            self.send_error(400, f"bad request body: {e}")
            return

        doc_id = req.get("doc_id", "")
        query  = req.get("query", "").strip()
        k      = int(req.get("k", 4))
        if not doc_id or not query:
            self.send_error(400, "doc_id + query required")
            return
        cache_path = DOCUMENT_CACHE_DIR / f"{doc_id}.json"
        if not cache_path.exists():
            self.send_error(404, "doc not prepared — call /document/prepare first")
            return
        cached = _json.loads(cache_path.read_text())

        # Embed query
        payload = _json.dumps({"model": EMBED_MODEL, "prompt": query}).encode("utf-8")
        ereq = _ur.Request(
            f"{EMBED_OLLAMA_URL}/api/embeddings",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            with _ur.urlopen(ereq, timeout=20) as resp:
                qe = _json.loads(resp.read().decode("utf-8")).get("embedding", [])
        except Exception as e:
            self.send_error(500, f"embed query failed: {e}")
            return
        if not qe:
            self.send_error(500, "empty query embedding")
            return

        # Cosine similarity
        def cos(a, b):
            num = sum(x * y for x, y in zip(a, b))
            da = _math.sqrt(sum(x * x for x in a))
            db = _math.sqrt(sum(x * x for x in b))
            return num / (da * db) if da and db else 0.0

        scored = []
        for ch in cached.get("chunks", []):
            scored.append({
                "text":  ch["text"],
                "page":  ch.get("page", 0),
                "score": cos(qe, ch["embedding"]),
            })
        scored.sort(key=lambda x: x["score"], reverse=True)
        top = scored[:max(1, k)]

        body = _json.dumps({
            "doc_id":  doc_id,
            "title":   cached.get("title", ""),
            "name":    cached.get("name", ""),
            "matches": top,
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── Chat log (the disk-side companion to the IndexedDB chain) ────
    def _write_chat_log(self) -> None:
        """POST /chat-log → body is the full signed envelope (with full
        response). Writes one file per turn at CHAT_LOG_DIR/<turn_id>.json
        and returns {"status": "ok", "log_path": "<turn_id>.json"} so the
        client can store it on the chain block.

        turn_id is derived from the envelope's signature (first 32 hex
        chars) — collision-free for any one signing key, and the operator
        can find a turn from the chain by signature substring.
        """
        import hashlib as _hashlib  # noqa: PLC0415
        import json as _json  # noqa: PLC0415
        import re as _re  # noqa: PLC0415
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw    = self.rfile.read(length).decode("utf-8") if length else ""
            envelope = _json.loads(raw) if raw else {}
        except Exception as e:
            self.send_error(400, f"bad request body: {e}")
            return
        if not isinstance(envelope, dict):
            self.send_error(400, "envelope must be a JSON object")
            return

        sig = envelope.get("signature", "")
        if not isinstance(sig, str) or not _re.fullmatch("[a-fA-F0-9]+", sig) or len(sig) < 16:
            # No / weak signature — derive a content-based id so we still get
            # a stable filename instead of failing
            content_hash = _hashlib.sha256(raw.encode("utf-8")).hexdigest()
            turn_id = f"unsig-{content_hash[:32]}"
        else:
            turn_id = sig[:32]
        filename = f"{turn_id}.json"
        if not _re.fullmatch(_TURN_ID_RE, filename):
            self.send_error(400, "derived turn_id is not a safe filename")
            return

        # Sanity-check the size — refuse pathological 100MB envelopes
        if len(raw) > 5 * 1024 * 1024:
            self.send_error(413, "envelope exceeds 5 MB")
            return

        # F-6: exclusive create. Idempotent on identical re-POSTs (legitimate
        # retry); 409 on collision with different content (silent overwrite
        # would destroy the prior turn's record).
        try:
            _chat_log_dir().mkdir(parents=True, exist_ok=True)
            target = _chat_log_dir() / filename
            try:
                with open(target, "x", encoding="utf-8") as f:
                    f.write(raw)
            except FileExistsError:
                # Compare bytes — if identical, treat as idempotent success
                # (e.g. SPA retried a successful POST). Otherwise 409.
                if target.read_text(encoding="utf-8") == raw:
                    pass    # identical — silently succeed
                else:
                    self.send_error(409,
                        f"chat-log {filename} already exists with different content")
                    return
        except OSError as e:
            self.send_error(500, f"chat-log write failed: {e}")
            return

        body = _json.dumps({"status": "ok", "log_path": filename}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_chat_log(self, name: str) -> None:
        """GET /chat-log/<turn_id>.json → the full envelope as written.
        Path safety: name must match _TURN_ID_RE (safe filename only)."""
        import re as _re  # noqa: PLC0415
        if not _re.fullmatch(_TURN_ID_RE, name):
            self.send_error(400, "invalid chat-log filename")
            return
        path = (_chat_log_dir() / name).resolve()
        try:
            path.relative_to(_chat_log_dir().resolve())
        except ValueError:
            self.send_error(400, "chat-log path escapes its root")
            return
        if not path.is_file():
            self.send_error(404, "chat-log not found")
            return
        try:
            data = path.read_bytes()
        except OSError as e:
            self.send_error(500, f"read failed: {e}")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(data)

    # ── VPO signing (bridge to Rust vpo-server for Ed25519) ────────────
    def _sign_form_vpo(self) -> None:
        """POST /vpo/sign → body is { form_type, form_data, signed_at, signer, prev_hash }.
        Forward to vpo-server /api/v1/vpo/sign for Ed25519 signing.
        Compute block_hash = SHA-256(prev_hash || payload_hash).
        Returns { signature, signer_id, public_key, algorithm, signed_at, block_hash, prev_hash }.

        On error (vpo-server unreachable): HTTP 503 with message to start it.
        """
        import hashlib as _hashlib  # noqa: PLC0415
        import json as _json  # noqa: PLC0415
        import urllib.request as _urllib  # noqa: PLC0415
        import urllib.error as _urlerror  # noqa: PLC0415
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            payload = _json.loads(raw) if raw else {}
        except Exception as e:
            self.send_error(400, f"bad vpo payload: {e}")
            return

        if not isinstance(payload, dict):
            self.send_error(400, "payload must be a JSON object")
            return

        form_type = payload.get("form_type", "ICS-201")
        form_data = payload.get("form_data", {})
        signed_at = payload.get("signed_at", "")
        signer = payload.get("signer", "")
        prev_hash = payload.get("prev_hash", "0" * 64)  # Genesis block default

        # Construct a minimal Vpo struct for vpo-server signing
        from datetime import datetime, timezone  # noqa: PLC0415
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        vpo = {
            "entityId": f"ics-form-{form_data.get('incident', 'draft')}",
            "version": 1,
            "createdTime": now_iso,
            "updatedTime": now_iso,
            "isLive": True,
            "ontology": {
                "platformType": "vpo",
                "specificType": form_type,
                "domain": "civilian",
            },
            "aliases": {
                "name": f"{form_type} by {signer}",
            },
            "vpoDomainData": form_data,
        }

        # Compute payload_hash for block linking
        # Use sorted keys for canonical representation
        vpo_json = _json.dumps(vpo, separators=(",", ":"), sort_keys=True)
        payload_hash = _hashlib.sha256(vpo_json.encode("utf-8")).hexdigest()

        # Compute block_hash = SHA-256(prev_hash || payload_hash)
        block_hash_input = prev_hash + payload_hash
        block_hash = _hashlib.sha256(block_hash_input.encode("utf-8")).hexdigest()

        # Try vpo-server (Ed25519); fall back to HMAC-SHA256 using the configured
        # signing key so the chain works out-of-the-box without the Rust stack.
        vpo_server_url = "http://127.0.0.1:8767/api/v1/vpo/sign"
        signature = ""
        signing_key_id = ""
        public_key = ""
        algorithm = "HMAC-SHA256"
        signed_at_server = now_iso
        try:
            req = _urllib.Request(
                vpo_server_url,
                data=vpo_json.encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with _urllib.urlopen(req, timeout=5) as resp:
                signed_vpo = _json.loads(resp.read().decode("utf-8"))
            crypto_block = signed_vpo.get("vpoCrypto") or {}
            signature = crypto_block.get("signature", "")
            signing_key_id = crypto_block.get("signerId", "")
            public_key = crypto_block.get("publicKey", "")
            algorithm = crypto_block.get("algorithm", "ed25519")
            signed_at_server = crypto_block.get("signedAt", now_iso)
        except Exception:
            # vpo-server not reachable — HMAC-SHA256 fallback using configured key.
            # Same scheme as the demo key (_DEMO_KEY) so the chain panel classifies
            # blocks correctly and the demo works without the Rust binary.
            import hmac as _hmac  # noqa: PLC0415
            signing_spec = _read_signing_key()
            hmac_key = signing_spec["key"].encode("utf-8")
            signature = _hmac.new(hmac_key, vpo_json.encode("utf-8"),
                                  _hashlib.sha256).hexdigest()
            algorithm = "HMAC-SHA256"
            signing_key_id = signing_spec["key_id"]
            public_key = ""

        response = {
            "signature":      signature,
            "signing_key_id": signing_key_id,   # chain.js classifyKey() reads this
            "signer":         signer,
            "public_key":     public_key,
            "algorithm":      algorithm,
            "signed_at":      signed_at_server,
            "block_hash":     block_hash,
            "prev_hash":      prev_hash,
            "payload_hash":   payload_hash,
            # Echo request fields back so chain.js can render the block payload
            # regardless of which client-side form.js version is in the browser cache.
            "form_type":      form_type,
            "form_data":      form_data,
        }

        body = _json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── Chain mirror (server-side append-only ledger) ────────────────
    def _append_chain_block(self) -> None:
        """POST /chain → body is a fully-formed signed block JSON. Append
        as one JSONL line to data/chain.jsonl. Returns {"status":"ok",
        "ordinal": <line-number>}.

        The block_hash + prev_signature linkage is owned by the client
        (chain.js linkBlock); this endpoint just durably records what the
        client computed. That keeps the server stateless re: chain order
        — multiple browsers / devices can mirror to the same file.
        """
        import json as _json  # noqa: PLC0415
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw    = self.rfile.read(length).decode("utf-8") if length else ""
            block  = _json.loads(raw) if raw else {}
        except Exception as e:
            self.send_error(400, f"bad chain block JSON: {e}")
            return
        if not isinstance(block, dict) or not block.get("signature"):
            self.send_error(400, "block must be a JSON object with signature")
            return
        if len(raw) > 5 * 1024 * 1024:
            self.send_error(413, "chain block exceeds 5 MB")
            return

        # F-5: enforce prev_signature linkage. Read the last line of the
        # existing chain (if any). The new block's prev_signature must equal
        # that block's signature; for the very first block, prev_signature
        # must be null/absent. Reject duplicates by signature.
        new_sig = block.get("signature")
        new_prev = block.get("prev_signature")
        line = _json.dumps(block, separators=(",", ":")) + "\n"
        try:
            _chain_log_path().parent.mkdir(parents=True, exist_ok=True)
            with _CHAIN_LOCK:
                last_block: dict | None = None
                seen_sigs: set[str] = set()
                if _chain_log_path().is_file():
                    with open(_chain_log_path(), "r", encoding="utf-8") as f:
                        for existing_line in f:
                            existing_line = existing_line.strip()
                            if not existing_line:
                                continue
                            try:
                                parsed = _json.loads(existing_line)
                                if isinstance(parsed, dict):
                                    last_block = parsed
                                    sig = parsed.get("signature")
                                    if isinstance(sig, str):
                                        seen_sigs.add(sig)
                            except Exception:
                                continue
                # Dedup: same signature = silently OK (idempotent retry)
                # but doesn't append a second line.
                if new_sig in seen_sigs:
                    body = _json.dumps({
                        "status": "ok", "ordinal": len(seen_sigs),
                        "deduped": True,
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                # Linkage check
                if last_block is None:
                    # Genesis: prev_signature must be null or absent
                    if new_prev not in (None, "", "null"):
                        self.send_error(409,
                            "first block must have null prev_signature; got " +
                            str(new_prev)[:32])
                        return
                else:
                    expected_prev = last_block.get("signature")
                    if new_prev != expected_prev:
                        self.send_error(409,
                            f"prev_signature mismatch - expected {str(expected_prev)[:16]}, got {str(new_prev)[:16]}")
                        return
                # All checks passed — append.
                with open(_chain_log_path(), "a", encoding="utf-8") as f:
                    f.write(line)
                ordinal = len(seen_sigs) + 1
        except OSError as e:
            self.send_error(500, f"chain append failed: {e}")
            return
        body = _json.dumps({"status": "ok", "ordinal": ordinal}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_chain(self) -> None:
        """GET /chain → JSON {"count": N, "blocks": [...]} reading every
        line from data/chain.jsonl. Used by chain.js on first load to
        rehydrate the IndexedDB if it's empty."""
        import json as _json  # noqa: PLC0415
        if not _chain_log_path().is_file():
            payload = _json.dumps({"count": 0, "blocks": []}).encode("utf-8")
        else:
            blocks = []
            try:
                with _CHAIN_LOCK:
                    with open(_chain_log_path(), "r", encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                blocks.append(_json.loads(line))
                            except Exception:
                                # Skip corrupt lines — better to surface a
                                # partial chain than a hard 500
                                continue
            except OSError as e:
                self.send_error(500, f"chain read failed: {e}")
                return
            payload = _json.dumps({"count": len(blocks), "blocks": blocks}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    # ── Signing identity (per-deployment key) ────────────────────────
    def _serve_upload_mobile(self) -> None:
        """GET /upload-mobile?s=<session-id>
        Serves a minimal mobile-optimised HTML upload page that posts a file
        to /upload-file with the session cookie pre-filled via query param.
        """
        from urllib.parse import urlparse, parse_qs  # noqa: PLC0415
        qs  = parse_qs(urlparse(self.path).query)
        sid = (qs.get("s", [""])[0]).strip()
        cookie_js = f'document.cookie="svs_session={sid};path=/;max-age=14400";' if sid else ""
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>TE NIMS Upload</title>
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{background:#0d0d0e;color:#e8e8e8;font-family:ui-monospace,monospace;
         display:flex;flex-direction:column;align-items:center;padding:24px 16px;min-height:100vh}}
    h1{{color:#e8551a;font-size:22px;margin-bottom:8px}}
    p{{color:#888;font-size:12px;margin-bottom:24px;text-align:center}}
    .btn{{display:block;width:100%;max-width:360px;background:#e8551a;border:none;
          border-radius:6px;color:#fff;cursor:pointer;font-size:16px;font-weight:700;
          padding:16px;margin:8px 0;text-align:center}}
    .btn-ghost{{background:transparent;border:2px solid #2a2a2c;color:#888}}
    input[type=file]{{display:none}}
    #status{{margin-top:20px;font-size:12px;color:#4caf50;text-align:center}}
    #error{{margin-top:12px;font-size:12px;color:#e74c3c;text-align:center}}
  </style>
</head>
<body>
  <h1><span style="color:#e8551a">T</span><span style="color:#fff">E</span> NIMS</h1>
  <p>Upload a photo or file to the active incident session.</p>
  <label class="btn" for="camera">📷 Take Photo</label>
  <input id="camera" type="file" accept="image/*" capture="environment">
  <label class="btn btn-ghost" for="gallery">🖼 Choose from Gallery / Files</label>
  <input id="gallery" type="file" accept="image/*,application/pdf,.json,.txt,.csv" multiple>
  <div id="status"></div>
  <div id="error"></div>
  <script>
    {cookie_js}
    async function upload(files) {{
      const status = document.getElementById("status");
      const err    = document.getElementById("error");
      for (const f of files) {{
        status.textContent = "Uploading " + f.name + "…";
        const fd = new FormData(); fd.append("file", f);
        const r = await fetch("/upload-file", {{method:"POST",body:fd}}).catch(e=>{{err.textContent=e.message;return null}});
        if (!r || !r.ok) {{ err.textContent = "Upload failed"; continue; }}
        status.textContent = "✓ " + f.name + " uploaded successfully!";
      }}
    }}
    document.getElementById("camera").addEventListener("change",  e => upload(e.target.files));
    document.getElementById("gallery").addEventListener("change", e => upload(e.target.files));
  </script>
</body>
</html>""".encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def _handle_upload_file(self) -> None:
        """POST /upload-file — multipart file upload from the mobile QR page.
        Saves to a session-scoped uploads dir so the desktop app can poll and
        attach the file to the chat. Returns {"ok": true, "id": "<name>", "url": "..."}.
        """
        import json as _json  # noqa: PLC0415
        import re as _re      # noqa: PLC0415
        import email          # noqa: PLC0415
        ct = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ct:
            self.send_error(400, "expected multipart/form-data")
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > 50 * 1024 * 1024:      # 50 MB cap
            self.send_error(413, "file too large (max 50 MB)")
            return
        raw = self.rfile.read(length)
        # Extract boundary
        boundary = None
        for part in ct.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part[9:].strip('"')
                break
        if not boundary:
            self.send_error(400, "missing boundary")
            return
        # Parse multipart body manually (avoid cgi.FieldStorage deprecation)
        filename = "upload.bin"
        file_bytes = b""
        sep = ("--" + boundary).encode()
        parts = raw.split(sep)
        for block in parts:
            if b"Content-Disposition" not in block:
                continue
            if b'\r\n\r\n' not in block:
                continue
            hdr_raw, body = block.split(b'\r\n\r\n', 1)
            body = body.rstrip(b'\r\n--')
            hdr_text = hdr_raw.decode("utf-8", errors="replace")
            m = _re.search(r'filename="([^"]+)"', hdr_text)
            if m:
                filename = m.group(1)
                file_bytes = body
                break
        if not file_bytes:
            self.send_error(400, "no file data found")
            return
        safe_name = _re.sub(r"[^\w.\-]", "_", Path(filename).name)[:120]
        uploads_dir = _chat_log_dir() / "uploads"
        uploads_dir.mkdir(parents=True, exist_ok=True)
        dest = uploads_dir / safe_name
        dest.write_bytes(file_bytes)
        url = f"/session-upload/{safe_name}"
        out = _json.dumps({"ok": True, "id": safe_name, "url": url, "size": len(file_bytes)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(out)

    def _poll_uploads(self) -> None:
        """GET /uploads — returns list of files recently uploaded via /upload-file.
        Desktop app polls this to show 'N new photos from mobile' notification.
        """
        import json as _json  # noqa: PLC0415
        uploads_dir = _chat_log_dir() / "uploads"
        files = []
        if uploads_dir.is_dir():
            for f in sorted(uploads_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
                if f.is_file():
                    files.append({
                        "id":   f.name,
                        "url":  f"/session-upload/{f.name}",
                        "size": f.stat().st_size,
                        "mtime": f.stat().st_mtime,
                    })
        out = _json.dumps({"files": files}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(out)

    def _serve_session_upload(self, name: str) -> None:
        """GET /session-upload/<name> — serve an uploaded file back to the browser."""
        import mimetypes as _mt  # noqa: PLC0415
        uploads_dir = _chat_log_dir() / "uploads"
        path = (uploads_dir / name).resolve()
        try:
            path.relative_to(uploads_dir.resolve())
        except ValueError:
            self.send_error(403, "forbidden")
            return
        if not path.is_file():
            self.send_error(404, "not found")
            return
        mime = _mt.guess_type(name)[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    def _serve_signing_key(self) -> None:
        """GET /signing-key → {"key_id": "...", "scheme": "HMAC-SHA256",
        "key": "<base64-or-string>", "loaded_from": "<path|default>"}.

        Reads data/.signing-key.json if present; otherwise returns the
        demo key. The SPA fetches this at boot and uses key_id + key
        verbatim so production deployments can drop in a real identity
        without touching JS.
        """
        import json as _json  # noqa: PLC0415
        spec = _read_signing_key()
        body = _json.dumps(spec).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Don't cache — operator may rotate the key between page loads
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # ── Verify endpoints (shell out to te-verify CLI) ────────────────
    def _run_te_verify(self, args: list[str]) -> None:
        """Locate the te-verify binary, run it with --json, return its
        report. Args are appended to the binary invocation (e.g. ['chain',
        '--log', 'data/chat-log/', '--key-file', 'data/.signing-key.json']).

        Returns the te-verify JSON unchanged so the JS animator can walk
        the same shape Rust produced. Exit codes other than 0/1 are
        surfaced as 500 (te-verify itself broke).
        """
        import subprocess as _sp     # noqa: PLC0415
        import json as _json         # noqa: PLC0415
        bin_path = _find_te_verify()
        if bin_path is None:
            self.send_error(503, "te-verify binary not found - see SEVERIAN_TE_VERIFY_BIN")
            return
        try:
            result = _sp.run(
                [str(bin_path), *args, "--json"],
                capture_output=True, timeout=30, text=True,
            )
        except _sp.TimeoutExpired:
            self.send_error(504, "te-verify timed out (>30s)")
            return
        except OSError as e:
            self.send_error(500, f"te-verify exec failed: {e}")
            return
        # Exit codes: 0 = all-ok, 1 = failures (still has JSON on stdout),
        # 2 = empty/missing, 3 = unrecoverable. Pass 0/1/2 through; 3 is 500.
        if result.returncode == 3:
            self.send_error(500, f"te-verify error: {result.stderr.strip()[:300]}")
            return
        # Parse the report (must be valid JSON since we passed --json)
        try:
            report = _json.loads(result.stdout) if result.stdout.strip() else {}
        except _json.JSONDecodeError as e:
            self.send_error(500, f"te-verify returned non-JSON: {e}")
            return
        # Wrap with the exit code so the client knows the verdict at a glance
        # without having to recompute from the counts.
        wrapped = {
            "exit_code": result.returncode,
            "verdict":   ["all-ok", "failures", "empty"][min(result.returncode, 2)],
            "report":    report,
        }
        body = _json.dumps(wrapped).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _verify_chain(self) -> None:
        """POST /verify → run `te-verify chain --log ... --key-file ...`."""
        self._run_te_verify([
            "chain",
            "--log", str(_chat_log_dir()),
            "--key-file", str(SIGNING_KEY_PATH),
        ])

    def _verify_chain_mirror(self) -> None:
        """POST /verify-mirror → run `te-verify chain-mirror --file ...`."""
        self._run_te_verify([
            "chain-mirror",
            "--file", str(_chain_log_path()),
        ])

    def do_OPTIONS(self) -> None:  # noqa: N802 — CORS preflight for mobile Safari
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        self._init_session()
        # POST /vpo/sign  → forward to vpo-server for Ed25519 signing
        if self.path == "/vpo/sign" or self.path.startswith("/vpo/sign?"):
            self._sign_form_vpo()
            return
        # POST /verify  → run te-verify chain on data/chat-log/
        if self.path == "/verify" or self.path.startswith("/verify?"):
            self._verify_chain()
            return
        # POST /verify-mirror  → run te-verify chain-mirror on data/chain.jsonl
        if self.path == "/verify-mirror" or self.path.startswith("/verify-mirror?"):
            self._verify_chain_mirror()
            return
        # POST /chain  body = signed block JSON
        if self.path.startswith("/chain") and not self.path.startswith("/chain-log"):
            self._append_chain_block()
            return
        # POST /chat-log  body = signed envelope JSON
        if self.path.startswith("/chat-log"):
            self._write_chat_log()
            return
        # POST /ics-forms/reset — wipe all versioned copies from saved-forms/
        if self.path.startswith("/ics-forms/reset"):
            self._reset_ics_forms()
            return
        # POST /ics-forms/save — snapshot current PDF to saved-forms/ with timestamp
        if self.path.startswith("/ics-forms/save"):
            self._save_ics_form()
            return
        # POST /demo/reset — wipe all server-side session state
        if self.path.startswith("/demo/reset"):
            self._demo_reset()
            return
        # POST /demo/load — seed Moore EF5 Tornado 2013 scenario
        if self.path.startswith("/demo/load"):
            self._demo_load()
            return
        # POST /memory/* — Mem0+Qdrant session memory (shared with CLI)
        if self.path.startswith("/memory/add"):
            self._memory_add()
            return
        if self.path.startswith("/memory/context"):
            self._memory_context()
            return
        # POST /document/prepare and /document/query — RAG over Library PDFs
        if self.path.startswith("/document/prepare"):
            self._document_prepare()
            return
        if self.path.startswith("/document/query"):
            self._document_query()
            return
        # POST /tts  body = {"text": "..."}
        if self.path.startswith("/tts"):
            length = int(self.headers.get("Content-Length", 0))
            try:
                body = self.rfile.read(length).decode("utf-8") if length else ""
                import json as _json  # noqa: PLC0415
                payload = _json.loads(body) if body else {}
                text = (payload.get("text") or "").strip()
            except Exception as e:
                self.send_error(400, f"bad request: {e}")
                return
            self._serve_tts(text)
            return
        # POST /tools/<name> — ReAct tool execution
        if self.path.startswith("/tools/"):
            tool_name = self.path.removeprefix("/tools/").split("?")[0]
            self._execute_tool(tool_name)
            return
        # POST /artifacts/save — save HTML doc artifact
        if self.path.startswith("/artifacts/save"):
            self._save_doc_artifact()
            return
        # POST /upload-file — multipart file upload from mobile QR page
        if self.path == "/upload-file" or self.path.startswith("/upload-file?"):
            self._handle_upload_file()
            return
        # POST /api/ollama/<path> → Ollama proxy (avoids browser CORS)
        if self.path.startswith("/api/ollama/"):
            self._proxy_ollama("POST")
            return
        self.send_error(405, "method not allowed")

    def do_PUT(self) -> None:  # noqa: N802
        # PUT /library/<filename> — replace an existing ICS form PDF in LIBRARY_DIR.
        # Only existing .pdf files may be replaced; no new files, no path traversal.
        from urllib.parse import unquote  # noqa: PLC0415
        prefix = "/library/"
        if not self.path.startswith(prefix):
            self.send_error(405, "method not allowed")
            return
        name = unquote(self.path[len(prefix):].split("?")[0])
        if "/" in name or "\\" in name or name.startswith("..") or not name.lower().endswith(".pdf"):
            self.send_error(400, "invalid filename")
            return
        target = (LIBRARY_DIR / name).resolve()
        try:
            target.relative_to(LIBRARY_DIR.resolve())
        except ValueError:
            self.send_error(400, "path escapes library root")
            return
        if not target.is_file():
            # Only replace; never create new files via PUT.
            self.send_error(404, "file not in library; only existing files can be replaced")
            return
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            self.send_error(400, "empty body")
            return
        data = self.rfile.read(length)
        if not data.startswith(b"%PDF"):
            self.send_error(400, "body is not a PDF")
            return
        target.write_bytes(data)
        import json as _json  # noqa: PLC0415
        out = _json.dumps({"ok": True, "name": name, "size": len(data)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def do_GET(self) -> None:  # noqa: N802 (http.server convention)
        self._init_session()
        # GET /demo/damage — building damage heatmap + track overlay data
        if self.path == "/demo/damage" or self.path.startswith("/demo/damage?"):
            self._demo_damage()
            return
        # GET /demo/track — Moore EF5 tornado track GeoJSON
        if self.path == "/demo/track" or self.path.startswith("/demo/track?"):
            self._demo_track()
            return
        # GET /demo/buildings — Microsoft ML building footprints (peer model)
        if self.path == "/demo/buildings" or self.path.startswith("/demo/buildings?"):
            self._demo_buildings()
            return
        # Match /status (boot health panel consumed by app.js banner)
        if self.path == "/status" or self.path.startswith("/status?"):
            self._serve_status()
            return
        # Match /memory/* GET endpoints
        if self.path == "/memory/list" or self.path.startswith("/memory/list?"):
            self._memory_list()
            return
        if self.path == "/memory/clear" or self.path.startswith("/memory/clear?"):
            self._memory_clear()
            return
        if self.path == "/memory/status" or self.path.startswith("/memory/status?"):
            self._memory_status()
            return
        # Match /tts?text=... (GET form for simple <audio> tag use)
        if self.path.startswith("/tts"):
            from urllib.parse import urlparse, parse_qs  # noqa: PLC0415
            q = parse_qs(urlparse(self.path).query)
            text = (q.get("text", [""])[0]).strip()
            self._serve_tts(text)
            return
        # Match /chain  (full chain mirror — used by chain.js on first load
        # to rehydrate IndexedDB after a browser-data clear)
        if self.path == "/chain" or self.path.startswith("/chain?"):
            self._read_chain()
            return
        # Match /signing-key (per-deployment signing identity descriptor)
        if self.path == "/signing-key" or self.path.startswith("/signing-key?"):
            self._serve_signing_key()
            return
        # GET /upload-mobile — mobile QR-code upload page
        if self.path == "/upload-mobile" or self.path.startswith("/upload-mobile?"):
            self._serve_upload_mobile()
            return
        # GET /uploads — poll for files uploaded from mobile
        if self.path == "/uploads" or self.path.startswith("/uploads?"):
            self._poll_uploads()
            return
        # GET /session-upload/<name> — serve an uploaded file
        if self.path.startswith("/session-upload/"):
            name = self.path.removeprefix("/session-upload/").split("?")[0]
            self._serve_session_upload(name)
            return
        # Match /chat-log/<turn-id>.json (verification fetch)
        if self.path.startswith("/chat-log/"):
            from urllib.parse import unquote  # noqa: PLC0415
            tail = unquote(self.path.removeprefix("/chat-log/").split("?")[0])
            self._read_chat_log(tail)
            return
        # Match /artifacts (list) or /artifacts/<id> (single image)
        if self.path == "/artifacts" or self.path.startswith("/artifacts?"):
            self._list_artifacts()
            return
        if self.path.startswith("/artifacts/"):
            from urllib.parse import unquote  # noqa: PLC0415
            tail = unquote(self.path.removeprefix("/artifacts/").split("?")[0])
            self._serve_artifact(tail)
            return
        # GET /ics-forms/open?name=<filename> — open PDF in OS default app
        if self.path.startswith("/ics-forms/open"):
            self._open_ics_form_native()
            return
        # Match /ics-forms (grouped ICS form PDF listing)
        if self.path == "/ics-forms" or self.path.startswith("/ics-forms?"):
            self._list_ics_forms()
            return
        # Match /library (list) or /library/<name>.pdf (single doctrine PDF)
        if self.path == "/library" or self.path.startswith("/library?"):
            self._list_library()
            return
        if self.path.startswith("/library/"):
            from urllib.parse import unquote  # noqa: PLC0415
            tail = unquote(self.path.removeprefix("/library/").split("?")[0])
            self._serve_library_pdf(tail)
            return
        # GET /api/odin/layers → Odin gold layer stats (feeds Data tab)
        if self.path == "/api/odin/layers" or self.path.startswith("/api/odin/layers?"):
            self._odin_layers()
            return
        # GET /api/ollama/<path> → Ollama proxy (avoids browser CORS)
        if self.path.startswith("/api/ollama/"):
            self._proxy_ollama("GET")
            return
        # Match /tiles/<z>/<x>/<y>.png
        if self.path.startswith("/tiles/"):
            tail = self.path.removeprefix("/tiles/").split("?")[0]
            parts = tail.split("/")
            if len(parts) == 3 and parts[2].endswith(".png"):
                try:
                    z = int(parts[0])
                    x = int(parts[1])
                    y = int(parts[2][:-4])
                except ValueError:
                    self.send_error(400, "bad tile path")
                    return
                self._serve_tile(z, x, y)
                return
        # Anything else falls through to static files
        super().do_GET()

    # Quieter access log
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")


def main() -> None:
    p = argparse.ArgumentParser(description="TE NIMS FOB web — static + MBTiles server")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--mbtiles", default=DEFAULT_MBTILES,
                   help=f"path to .mbtiles file (default: {DEFAULT_MBTILES})")
    args = p.parse_args()

    here = Path(__file__).parent.resolve()
    os.chdir(here)

    mbtiles = Path(args.mbtiles)
    if not mbtiles.is_absolute():
        mbtiles = here / mbtiles

    if not mbtiles.is_file():
        print(f"WARN: MBTiles file not found at {mbtiles}", file=sys.stderr)
        print(f"      /tiles/* requests will 500 until the file exists.", file=sys.stderr)
    else:
        print(f"MBTiles : {mbtiles}", file=sys.stderr)

    TileHandler.mbtiles_path = str(mbtiles)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", args.port), TileHandler) as httpd:
        print(f"Serving : http://localhost:{args.port}", file=sys.stderr)
        print(f"Static  : {here}", file=sys.stderr)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
