#!/bin/bash
# Test severian-vision multimodal inference end-to-end on the VM.
set -e
IMG="${1:-/opt/severian/app/severian-fob-web/icon-512.png}"
B64=$(base64 -w0 "$IMG")
JSON=$(python3 -c "
import json,sys
print(json.dumps({
  'model':'severian-vision',
  'messages':[{'role':'user','content':[
    {'type':'text','text':'Describe what you see in this image. One sentence.'},
    {'type':'image_url','image_url':{'url':'data:image/png;base64,'+sys.argv[1]}}
  ]}],
  'max_tokens':120, 'stream':False
}))
" "$B64")

echo "=== Direct llama-server (127.0.0.1:8081) ==="
time curl -s -m 120 -X POST http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d "$JSON" | python3 -m json.tool 2>&1 | head -50

echo ""
echo "=== Via Caddy public route (demo.terminusest.ai/vision) ==="
time curl -s -m 120 -X POST https://demo.terminusest.ai/vision/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d "$JSON" | python3 -m json.tool 2>&1 | head -50
