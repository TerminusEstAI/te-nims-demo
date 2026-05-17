#!/usr/bin/env bash
# TE NIMS Demo — container entrypoint
# On first run downloads the 5GB GGUF from HuggingFace (cached in Docker volume).
# Subsequent runs start in ~20 seconds.
set -euo pipefail

MODEL_DIR=/models
GGUF="$MODEL_DIR/severian.gguf"
HF_URL="https://huggingface.co/tmancino/te-nims-e4b-stage9-gguf/resolve/main/nims-e4b-stage9-q4_k_m.gguf"
VOICE_DIR="$HOME/.severian/voices"

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
    echo "▶ First run: downloading TE NIMS model (~5GB) from HuggingFace..."
    echo "  This happens once. Subsequent starts take ~20 seconds."
    echo ""
    curl -L --fail --progress-bar -o "$GGUF" "$HF_URL" || {
        echo "❌ Download failed. Check your internet connection and try again."
        exit 1
    }
    echo ""
    echo "✓ Model downloaded."
fi

# ── Download Piper TTS voice (first run) ───────────────────────────────
mkdir -p "$VOICE_DIR"
if [ ! -f "$VOICE_DIR/en_GB-alan-medium.onnx" ]; then
    echo "▶ Downloading TTS voice (60MB)..."
    curl -L --fail --progress-bar -o "$VOICE_DIR/en_GB-alan-medium.onnx" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx" || \
        echo "  ⚠ TTS voice download failed — voice responses will be silent."
    curl -L --fail --silent -o "$VOICE_DIR/en_GB-alan-medium.onnx.json" \
        "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json" || true
fi

# ── Start Ollama ────────────────────────────────────────────────────────
echo "▶ Starting Ollama inference server..."
OLLAMA_MODELS="$MODEL_DIR" ollama serve &
OLLAMA_PID=$!

# Wait for Ollama to be ready
for i in $(seq 1 30); do
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
        break
    fi
    sleep 1
done

# ── Create the Severian model ───────────────────────────────────────────
if ! ollama list 2>/dev/null | grep -q "severian-ollama"; then
    echo "▶ Registering severian-ollama model with Ollama..."
    OLLAMA_MODELS="$MODEL_DIR" ollama create severian-ollama -f /app/Modelfile
fi

# ── Pull supporting models for Mem0 session memory ─────────────────────
echo "▶ Pulling supporting models (llama3.2:3b + nomic-embed-text)..."
ollama pull llama3.2:3b  --insecure 2>/dev/null || true
ollama pull nomic-embed-text --insecure 2>/dev/null || true

# ── Start web server ────────────────────────────────────────────────────
echo ""
echo "✅ TE NIMS is ready!"
echo ""
echo "   Open in your browser: http://localhost:8765"
echo "   Type /demo in the chat to load the Moore EF5 tornado scenario."
echo ""

cd /app/web
exec python3 serve.py \
    --port 8765 \
    --mbtiles /app/imagery-cache/moore-esri-z11-z16.mbtiles
