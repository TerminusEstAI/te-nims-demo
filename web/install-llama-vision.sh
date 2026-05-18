#!/bin/bash
# Install systemd service + Caddy route for llama-vision sidecar.
# Run after setup-llama-cuda.sh has produced /opt/llama.cpp-vision/build/bin/llama-server.
set -e

MODEL_DIR=/opt/severian/model
SERVICE_USER=${SERVICE_USER:-root}
SERVICE_GROUP=${SERVICE_GROUP:-root}
VISION_GGUF=${VISION_GGUF:-$MODEL_DIR/severian-vision-q4_k_m.gguf}
VISION_MMPROJ=${VISION_MMPROJ:-$MODEL_DIR/mmproj-severian-vision.gguf}
VISION_GGUF_URL=${VISION_GGUF_URL:-https://huggingface.co/tmancino/severian-vision-gguf/resolve/main/severian-vision-q4_k_m.gguf}
VISION_MMPROJ_URL=${VISION_MMPROJ_URL:-https://huggingface.co/tmancino/severian-vision-mmproj/resolve/main/mmproj-severian-vision.gguf}

# 0. Sanity: binary exists
test -x /opt/llama.cpp-vision/build/bin/llama-server || { echo "ERROR: llama-server not built"; exit 1; }

# 0.5 Download deployable vision artifacts if missing
sudo mkdir -p "$MODEL_DIR"
if [ ! -f "$VISION_GGUF" ]; then
  echo "Downloading severian vision GGUF from Hugging Face..."
  sudo curl -L --fail --progress-bar -o "$VISION_GGUF" "$VISION_GGUF_URL"
fi
if [ ! -f "$VISION_MMPROJ" ]; then
  echo "Downloading severian vision mmproj from Hugging Face..."
  sudo curl -L --fail --progress-bar -o "$VISION_MMPROJ" "$VISION_MMPROJ_URL"
fi

# 1. Install systemd unit
sudo cp /tmp/llama-vision.service /etc/systemd/system/llama-vision.service
sudo touch /var/log/llama-vision.log
sudo chown "$SERVICE_USER:$SERVICE_GROUP" /var/log/llama-vision.log
sudo systemctl daemon-reload
sudo systemctl enable --now llama-vision

# 2. Patch Caddyfile — add /vision/* reverse_proxy inside demo.terminusest.ai block.
CADDY=/etc/caddy/Caddyfile
if ! sudo grep -q "handle_path /vision/" $CADDY; then
  # Insert the handle_path block right after the existing reverse_proxy line.
  sudo cp $CADDY ${CADDY}.bak.$(date +%s)
  sudo python3 - <<'PY'
import re
p = "/etc/caddy/Caddyfile"
with open(p) as f: t = f.read()
block = """
    handle_path /vision/* {
        reverse_proxy localhost:8081 {
            flush_interval -1
            transport http {
                read_timeout 600s
                write_timeout 600s
            }
        }
    }
"""
# Insert after the localhost:9000 reverse_proxy block (closing brace of that proxy).
needle = re.search(r"(reverse_proxy localhost:9000\s*\{[^}]*\})", t)
if not needle:
    raise SystemExit("Caddyfile: could not find reverse_proxy localhost:9000 block")
t = t[:needle.end()] + block + t[needle.end():]
with open(p, "w") as f: f.write(t)
print("Caddyfile patched")
PY
fi

# 3. Validate + reload Caddy
sudo caddy validate --config $CADDY
sudo systemctl reload caddy

# 4. Status
echo "---LLAMA-VISION---"
sudo systemctl status llama-vision --no-pager | head -10
echo "---CADDY---"
sudo systemctl status caddy --no-pager | head -5
