#!/usr/bin/env bash
# TE NIMS Demo — container entrypoint
# On first run downloads the 5GB GGUF from HuggingFace (cached in Docker volume).
# Subsequent runs start in ~20 seconds.
set -euo pipefail

MODEL_DIR=/models
GGUF="$MODEL_DIR/severian.gguf"
TEXT_GGUF_URL="${TEXT_GGUF_URL:-https://huggingface.co/tmancino/te-nims-e4b-stage9-gguf/resolve/main/nims-e4b-stage9-q4_k_m.gguf}"
VOICE_DIR="$HOME/.severian/voices"
VOICE_ONNX="$VOICE_DIR/en_GB-alan-medium.onnx"
VISION_URL="${SEVERIAN_VISION_URL:-}"

log_step() {
    echo "▶ $*"
}

log_ok() {
    echo "✓ $*"
}

log_warn() {
    echo "⚠ $*"
}

log_fail() {
    echo "❌ $*"
}

wait_for_http() {
    local url="$1"
    local label="$2"
    local attempts="${3:-60}"
    local delay="${4:-1}"
    for _ in $(seq 1 "$attempts"); do
        if curl -sf "$url" > /dev/null 2>&1; then
            log_ok "$label"
            return 0
        fi
        sleep "$delay"
    done
    log_fail "$label"
    return 1
}

cleanup() {
    local exit_code=$?
    if [ -n "${SERVER_PID:-}" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
    fi
    if [ -n "${OLLAMA_PID:-}" ]; then
        kill "$OLLAMA_PID" 2>/dev/null || true
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

echo ""
echo "  ████████╗███████╗    ███╗   ██╗██╗███╗   ███╗███████╗"
echo "     ██╔══╝██╔════╝    ████╗  ██║██║████╗ ████║██╔════╝"
echo "     ██║   █████╗      ██╔██╗ ██║██║██╔████╔██║███████╗"
echo "     ██║   ██╔══╝      ██║╚██╗██║██║██║╚██╔╝██║╚════██║"
echo "     ██║   ███████╗    ██║ ╚████║██║██║ ╚═╝ ██║███████║"
echo "     ╚═╝   ╚══════╝    ╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝╚══════╝"
echo ""
echo "  Terminus Est AI — NIMS/ICS Doctrine Decision Support"
echo ""

# ── Download GGUF on first run ──────────────────────────────────────────
mkdir -p "$MODEL_DIR"
if [ ! -f "$GGUF" ]; then
    log_step "First run: downloading TE NIMS text model (~5GB) from HuggingFace..."
    echo "  This happens once. Subsequent starts take ~20 seconds."
    echo ""
    curl -L --fail --progress-bar -o "$GGUF" "$TEXT_GGUF_URL" || {
        log_fail "Text model download failed. Check your internet connection and try again."
        exit 1
    }
    echo ""
    log_ok "Text model downloaded."
else
    log_ok "Text model already present."
fi

# ── Download Piper TTS voice (first run) ───────────────────────────────
mkdir -p "$VOICE_DIR"
if [ ! -f "$VOICE_ONNX" ]; then
    log_step "Downloading TTS voice (60MB)..."
    curl -L --fail --progress-bar -o "$VOICE_ONNX" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx" || \
        log_warn "TTS voice download failed — voice responses will be silent."
    curl -L --fail --silent -o "$VOICE_DIR/en_GB-alan-medium.onnx.json" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json" || true
    if [ -f "$VOICE_ONNX" ]; then
        log_ok "TTS voice ready."
    fi
else
    log_ok "TTS voice already present."
fi

# ── Start Ollama ────────────────────────────────────────────────────────
log_step "Starting Ollama inference server..."
OLLAMA_MODELS="$MODEL_DIR" ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to be ready
wait_for_http "http://localhost:11434/api/tags" "Ollama API reachable on :11434" 30 1

# ── Create the Severian model ───────────────────────────────────────────
if ! ollama list 2>/dev/null | grep -q "severian-ollama"; then
    log_step "Registering severian-ollama model with Ollama..."
    OLLAMA_MODELS="$MODEL_DIR" ollama create severian-ollama -f /app/Modelfile
    log_ok "severian-ollama registered."
else
    log_ok "severian-ollama already registered."
fi

# ── Pull supporting models for Mem0 session memory ─────────────────────
log_step "Pulling supporting models for memory/RAG (llama3.2:3b + nomic-embed-text)..."
ollama pull llama3.2:3b  --insecure 2>/dev/null || true
ollama pull nomic-embed-text --insecure 2>/dev/null || true
log_ok "Supporting model pull step complete."

# ── Optional vision sidecar status ──────────────────────────────────────
if [ -n "$VISION_URL" ]; then
    if curl -sf "${VISION_URL%/}/health" > /dev/null 2>&1; then
        log_ok "Vision sidecar reachable at ${VISION_URL%/}."
    else
        log_warn "Vision sidecar not yet reachable at ${VISION_URL%/}; image uploads may fail until it is ready."
    fi
fi

# ── Start web server ────────────────────────────────────────────────────
log_step "Starting TE NIMS web server on :8765..."
cd /app/web
python3 serve.py \
    --port 8765 \
    --mbtiles /app/imagery-cache/moore-esri-z11-z16.mbtiles &
SERVER_PID=$!

wait_for_http "http://localhost:8765/status" "Web UI status endpoint reachable on :8765" 60 1

echo ""
echo "✅ TE NIMS is ready!"
echo ""
echo "   Health summary:"
echo "   - Text model: ready"
if [ -f "$VOICE_ONNX" ]; then
    echo "   - TTS voice: ready"
else
    echo "   - TTS voice: missing (demo still usable, voice output may be silent)"
fi
echo "   - Ollama API: http://localhost:11434"
if [ -n "$VISION_URL" ]; then
    echo "   - Vision sidecar: ${VISION_URL%/}"
fi
echo "   - Web UI: http://localhost:8765"
echo ""
echo "   Open in your browser: http://localhost:8765"
echo "   Type /demo in the chat to load the Moore EF5 tornado scenario."
echo ""

wait "$SERVER_PID"
