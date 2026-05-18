# TE NIMS — AI-Powered Incident Command Decision Support

**TE NIMS** is an agentic AI harness running a fine-tuned Gemma 4 LLM designed to support first responder Incident Commanders with high-quality, doctrine-grounded decision support and agentic tooling.

Built on Google Gemma 4 E4B (4B parameters), fine-tuned on 50,000+ FEMA NIMS and ICS doctrinal elements. Runs fully offline after first-run artifact downloads — on a laptop, a workstation, or a thumb drive.

> *Saving Lives with AI* — [Terminus Est AI](https://terminusest.ai)

---

## 🚀 Try the Live Demo

**No installation required.** A fully-deployed instance runs on Google Cloud at:

### **[https://demo.terminusest.ai](https://demo.terminusest.ai)**

The live demo includes a **15-step guided tutorial** that walks through every capability — doctrine-grounded AI responses, ICS form generation, Gemma 4 multimodal vision (upload a hand-drawn org chart and have it redrawn to doctrine), geo-spatial incident map, PDF RAG, voice I/O, and a cryptographic audit chain.

Click <img src="https://img.shields.io/badge/%E2%96%B6%20Demo%20Walkthrough-e8551a?style=flat&labelColor=e8551a&color=e8551a&logo=&logoColor=white" alt="▶ Demo Walkthrough" height="20"/> on the splash screen to begin.

---

## Quick Start (Docker)

```bash
git clone https://github.com/TerminusEstAI/te-nims-demo
cd te-nims-demo
docker compose up
```

Open **http://localhost:8765** in your browser.

> **First run:** downloads the text GGUF, Piper voice, vision GGUF, and vision mmproj from Hugging Face. Subsequent starts reuse the named Docker volumes.
>
> **Port surface:** `8765` serves the complete browser demo. `11434` is exposed for optional direct Ollama access. The vision sidecar stays internal to Compose and is reached through the same-origin `/vision/*` proxy, so the browser does not need an extra port.
>
> **Voice input note:** voice output is fully local once Piper is cached. The shipped microphone path is browser-native Web Speech, so transcript quality depends on the browser and OS mic stack and should be treated as assisted dictation rather than a guaranteed offline radio path.

---

## What TE NIMS Does

```
You type:  "I'm Chief Martinez, Moore Fire Department, Incident Commander.
            EF5 tornado just hit. What's the situation?"

TE NIMS:   Calls weather/damage/imagery tools → grounds response in NIMS doctrine
           → cites ICS forms → generates ICS-201 on demand → signs every decision
           to a cryptographic VPO provenance chain.
```

---

## Features

### AI & Model
- **Doctrine-grounded responses** — every recommendation cites NIMS chapter/section; no hallucinated procedures
- **ICS form generation** — produces ICS-201, ICS-204, and others on demand from incident context
- **Retrieval Augmented Search (RAG)** — 66MB SQLite doctrine corpus; drag any PDF into chat to query it
- **Session memory** — remembers context within an incident session via Mem0
- **ReAct tool loop** — model calls geo, damage, imagery, and doctrine tools before answering
- **Gemma 4 multimodal vision** — upload field photos or hand-drawn org charts; model analyzes and redraws them to NIMS doctrine

### Interface
- **Guided 15-step demo tour** — floating draggable modal walks judges through every capability with pre-loaded queries
- **Geo-spatial map** — displays tornado damage track, building damage assessment, and AI-pinned locations in real time
- **Base imagery** — USGS National Map (public domain, USGSImageryOnly)
- **Voice input** — browser-native push-to-talk dictation via Web Speech API; best in Chrome, operator-reviewable before send, and not fully offline
- **Sentence-streaming TTS** — Piper offline TTS begins speaking after the first sentence arrives, not after the full response
- **Mobile QR upload** — scan a QR code on your phone to push field photos directly into the desktop chat session
- **Artifact panel** — saves chat responses, generated maps, and uploaded photos; drag any artifact back into chat
- **Library tab** — browse any PDFs bundled under `web/library/pdfs`; drag a PDF into chat to RAG over it

### Security & Audit
- **VPO provenance chain** — every chat turn is HMAC-SHA256 signed and chain-linked (demo signing key — illustrative chain for audit trail demonstration); full audit log survives page reload
- **Session isolation** — each visitor gets their own session cookie; uploads, artifacts, and chain are private

### Deployment
- **Offline local stack** — text inference, multimodal vision, doctrine RAG, and TTS run on your hardware after first-run artifact downloads
- **Docker single-command install** — `docker compose up` provisions the text model, vision sidecar, and web UI needed for the complete local demo
- **HEIC auto-conversion** — iPhone photos (HEIC format) are converted to JPEG server-side via pillow-heif
- **Hosted deployment watchdogs** — the public internet deployment uses systemd-style supervision; the local Docker path uses Compose restart policies
- **Self-hosted vision sidecar** — llama-server with Gemma 4 multimodal projector on CUDA for image analysis
- **Public artifact lineage** — text inference artifact, vision GGUF, and vision mmproj are published on Hugging Face as matching deployable artifacts

---

## Demo Scenario

The demo loads the **Moore, OK EF5 Tornado (May 20, 2013)**:

- 3,417 buildings destroyed, 2,417 major damage
- Tornado track from real NWS data  
- Building damage from xView2 satellite assessment
- Pre-loaded: Plaza Towers Elementary, Moore Medical Center, Moore Fire Station 1
- Base imagery from USGS National Map (public domain)

Type **`/demo`** in the chat to load the scenario, or click **▶ Demo Walkthrough** to start the guided tour.

---

## Agentic Harness Design

TE NIMS is not a chatbot wrapper around a model — it is an **agentic harness** where the model is one component of a larger decision pipeline. This distinction matters for emergency management, where answers must be grounded in doctrine, traceable to sources, and verifiable after the fact.

### ReAct Tool Loop

Every user query passes through a multi-step ReAct (Reason + Act) loop before a response is generated:

```
User query
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  severian-ollama (Gemma 4 E4B fine-tune)            │
│                                                     │
│  1. Reason: analyze query, identify what data needed│
│  2. Act:    emit <tool_call> to fetch live data     │
│  3. Observe: receive tool result                    │
│  4. Reason: ground answer in doctrine + live data   │
│  5. Respond: final answer with citations            │
└─────────────────────────────────────────────────────┘
```

Available tools the model can invoke:
- `get_scenario_info` — load incident context (location, damage data, staging areas)
- `search_doctrine` — RAG over NIMS/ICS doctrine corpus (50K+ chunks)
- `pin_map_location` — place a marker on the live geo map
- `zoom_map` — focus the map on a specific location
- `toggle_map_layer` — show/hide damage track or building assessment overlays

The harness routes tool calls, executes them server-side, and injects results back into the conversation before the model generates its final answer. Judges never see raw tool traces — only the grounded response.

### Provenance Chain

Every chat turn produces a signed block in the VPO (Verified Provenance Object) chain:

```
genesis block
     │
     ▼  prev_signature + HMAC-SHA256
turn 1 block → {query, response, tool_calls, timestamp, signature}
     │
     ▼  prev_signature + HMAC-SHA256
turn 2 block → {query, response, tool_calls, timestamp, signature}
     │
    ...
```

This creates an append-only audit log of the entire incident session — every decision, every tool call, every doctrine citation — that survives page reloads and can be exported for post-incident review. In production, the signing key would be held by the agency's command structure, not shared.

### Session Isolation

Each visitor receives a cryptographically random session cookie (`svs_session`). All artifacts, uploads, memory, and chain blocks are scoped to that session — judges cannot see each other's work.

---

## Hosted Reference Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser  →  Caddy (TLS)  →  serve.py :9000                  │
│              ├── /api/ollama/*   →  Ollama :11434             │
│              │     └── severian-ollama (text, Q4_K_M, 5.3GB) │
│              ├── /vision/*       →  llama-server :8081        │
│              │     └── severian-vision + mmproj (multimodal)  │
│              ├── /tts            →  Piper TTS (offline)       │
│              ├── /vpo/sign       →  HMAC-SHA256 signing       │
│              ├── /chain          →  VPO chain ledger          │
│              ├── /document/*     →  PDF RAG (pypdfium2 + nomic-embed-text) │
│              ├── /artifacts/*    →  session-scoped artifact store │
│              ├── /upload-file    →  HEIC→JPEG + session upload │
│              └── /demo/*         →  scenario data             │
└──────────────────────────────────────────────────────────────┘
```

- **serve.py** — single-process threaded Python HTTP server; no frameworks
- **Ollama** — local inference for text; `severian-ollama` (9-stage SFT fine-tune)
- **llama-server** — llama.cpp sidecar for vision; Gemma 4 multimodal with mmproj
- **chunks.db** — 66MB SQLite doctrine corpus (50K+ FEMA NIMS chunks, nomic-embed-text embeddings)
- **MBTiles** — 21MB offline satellite tile cache for the Moore, OK area

The local Docker quick start serves `serve.py` directly on `localhost:8765` and proxies `/vision/*` to the internal llama.cpp sidecar without requiring a separate externally exposed vision port.

---

## System Requirements

| | Minimum | Recommended |
|---|---|---|
| RAM | 8GB | 16GB |
| Disk | 10GB free | 20GB free |
| CPU | Any modern x86_64 | 8+ cores |
| GPU | Not required | NVIDIA CUDA (10× faster) |

**Token throughput** is governed by hardware. On CPU: ~5 tok/s. With a T4 GPU: ~44 tok/s (text) / ~47 tok/s (vision).

## Docker Runtime Notes

- Docker Desktop or another running Docker daemon is required before `docker compose up`.
- If you use Docker Desktop, allocate at least `12 GB` of Docker memory for a comfortable cold start. `16 GB` is preferred when running both the text path and the multimodal vision sidecar together.
- The quick start is CPU-compatible by default via `ghcr.io/ggml-org/llama.cpp:server`.
- To swap the vision sidecar to an accelerated llama.cpp image, set `LLAMA_CPP_IMAGE` before starting Compose, for example `ghcr.io/ggml-org/llama.cpp:server-cuda` on supported NVIDIA hosts.
- First boot still requires internet access for Ollama support-model pulls used by embeddings and session memory.
- Browser speech-to-text remains dependent on the host browser's Web Speech implementation even when the rest of the demo is running locally.

---

## Model

**Base model:** [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it)  
**Stage 9 adapter:** [tmancino/te-nims-e4b-stage9](https://huggingface.co/tmancino/te-nims-e4b-stage9)  
**Text GGUF for inference:** [tmancino/te-nims-e4b-stage9-gguf](https://huggingface.co/tmancino/te-nims-e4b-stage9-gguf) (Q4_K_M, 5.3GB)

### Vision artifacts

The demo's multimodal sidecar runs a separate `severian-vision` model under
`llama-server`. The runtime expects two deployable artifacts:

- `severian-vision-q4_k_m.gguf`
- `mmproj-severian-vision.gguf`

Published Hugging Face repos:

- `tmancino/severian-vision-gguf`
- `tmancino/severian-vision-mmproj`

See [docs/HUGGINGFACE-ARTIFACTS.md](docs/HUGGINGFACE-ARTIFACTS.md) for the
canonical runtime-to-artifact mapping.

Training: 9-stage SFT warm-start chain on FEMA NIMS doctrine, ICS procedures, and emergency management scenarios. Trained with [MLX](https://github.com/ml-explore/mlx) on Apple Silicon.

**Evaluation:** the repo documents two different scores on the 52-case TE NIMS internal benchmark: **0.7108** for the direct Stage 9 checkpoint and **0.916** for the full TE NIMS harness with retrieval/tools enabled. See [docs/ODA-BENCHMARK.md](docs/ODA-BENCHMARK.md) and [benchmark/oda-bench-v0](benchmark/oda-bench-v0/README.md) for methodology, published cases, and limitations.

> *Developing benchmark — not yet peer-reviewed. Single reviewer, significant train/test overlap. Treat as an internal signal, not an externally-validated score.*

---

## Sample Queries

```
"I'm Chief Martinez, Moore FD, IC. EF5 tornado just hit. What's the situation?"
"What are my immediate ICS priorities for life safety in the first operational period?"
"Generate an ICS-201 Incident Briefing for this incident."
"search doctrine for 'what are search team roles.'"
"Show me Plaza Towers Elementary on the map."
"What is the closest staging area to Plaza Towers?"
"Recommend resource typing for urban search-and-rescue at Plaza Towers."
"Create a doctrinally correct version of the diagram."
```

---

## License

CC BY 4.0 — see [LICENSE](LICENSE).

Third-party attributions: see [NOTICE](NOTICE).

---

## Citation

```bibtex
@software{te-nims-2026,
  title   = {TE NIMS: Fine-tuned Gemma 4 for NIMS/ICS Incident Command Decision Support},
  author  = {Terminus Est AI},
  year    = {2026},
  url     = {https://github.com/TerminusEstAI/te-nims-demo},
  license = {CC-BY-4.0}
}
```

---

*Submitted to the [Kaggle Gemma 4 Good Hackathon](https://www.kaggle.com/competitions/gemma-4-good-hackathon) · 2026*

---

*Gemma is a trademark of Google LLC. TE NIMS is not affiliated with or endorsed by Google.*
