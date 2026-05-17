# TE NIMS — AI-Powered Incident Command Decision Support

**TE NIMS** is an agentic AI harness running a fine-tuned Gemma 4 LLM designed to support first responder Incident Commanders with high-quality, doctrine-grounded decision support and agentic tooling.

Built on Google Gemma 4 E4B (4B parameters), fine-tuned on 50,000+ FEMA NIMS and ICS doctrinal elements. Runs fully offline — on a laptop, a workstation, or a thumb drive.

> *Saving Lives with AI* — [Terminus Est AI](https://terminusest.ai)

---

## 🚀 Try the Live Demo

**No installation required.** A fully-deployed instance runs on Google Cloud at:

### **[https://demo.terminusest.ai](https://demo.terminusest.ai)**

The live demo includes a **15-step guided tutorial** that walks through every capability — doctrine-grounded AI responses, ICS form generation, Gemma 4 multimodal vision (upload a hand-drawn org chart and have it redrawn to doctrine), geo-spatial incident map, PDF RAG, voice I/O, and a cryptographic audit chain.

Click **▶ Demo Walkthrough** on the splash screen to begin.

---

## Quick Start (Docker)

```bash
git clone https://github.com/TerminusEstAI/te-nims-demo
cd te-nims-demo
docker compose up
```

Open **http://localhost:8765** in your browser.

> **First run:** downloads the 5GB model from HuggingFace (~5 minutes on fast connection). Subsequent starts take ~20 seconds.

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
- **Voice input** — push-to-talk via Web Speech API (no model download)
- **Sentence-streaming TTS** — Piper offline TTS begins speaking after the first sentence arrives, not after the full response
- **Mobile QR upload** — scan a QR code on your phone to push field photos directly into the desktop chat session
- **Artifact panel** — saves chat responses, generated maps, and uploaded photos; drag any artifact back into chat
- **Library tab** — browse all NIMS/ICS doctrine PDFs; drag a PDF into chat to RAG over it

### Security & Audit
- **VPO provenance chain** — every chat turn is HMAC-SHA256 signed and chain-linked (demo signing key — illustrative chain for audit trail demonstration); full audit log survives page reload
- **Session isolation** — each visitor gets their own session cookie; uploads, artifacts, and chain are private

### Deployment
- **Fully offline** — no cloud API calls; model runs on your hardware via Ollama
- **Docker single-command install** — `docker compose up` pulls the model and starts everything
- **HEIC auto-conversion** — iPhone photos (HEIC format) are converted to JPEG server-side via pillow-heif
- **Systemd-supervised services** — watchdog timer restarts any crashed service within 60 seconds
- **Self-hosted vision sidecar** — llama-server with Gemma 4 multimodal projector on CUDA for image analysis

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

## Architecture

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

---

## System Requirements

| | Minimum | Recommended |
|---|---|---|
| RAM | 8GB | 16GB |
| Disk | 10GB free | 20GB free |
| CPU | Any modern x86_64 | 8+ cores |
| GPU | Not required | NVIDIA CUDA (10× faster) |

**Token throughput** is governed by hardware. On CPU: ~5 tok/s. With a T4 GPU: ~44 tok/s (text) / ~47 tok/s (vision).

---

## Model

**Base model:** [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it)  
**GGUF for inference:** [tmancino/te-nims-e4b-stage9-gguf](https://huggingface.co/tmancino/te-nims-e4b-stage9-gguf) (Q4_K_M, 5.3GB)

Training: 9-stage SFT warm-start chain on FEMA NIMS doctrine, ICS procedures, and emergency management scenarios. Trained with [MLX](https://github.com/ml-explore/mlx) on Apple Silicon. ODA bench score: **0.916** on the 52-case TE NIMS evaluation set.

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

Apache 2.0 — see [LICENSE](LICENSE).

Third-party attributions: see [NOTICE](NOTICE).

---

## Citation

```bibtex
@software{te-nims-2026,
  title   = {TE NIMS: Fine-tuned Gemma 4 for NIMS/ICS Incident Command Decision Support},
  author  = {Terminus Est AI},
  year    = {2026},
  url     = {https://github.com/TerminusEstAI/te-nims-demo},
  license = {Apache-2.0}
}
```

---

*Submitted to the [Kaggle Gemma 4 Good Hackathon](https://www.kaggle.com/competitions/gemma-4-good-hackathon) · 2026*

---

*Gemma is a trademark of Google LLC. TE NIMS is not affiliated with or endorsed by Google.*
