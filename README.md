# TE NIMS — AI-Powered Incident Command Decision Support

**TE NIMS** is an agentic AI harness running a fine-tuned Gemma 4 LLM designed to support first responder Incident Commanders with high-quality, doctrine-grounded decision support and agentic tooling.

Built on Google Gemma 4 E4B (4B parameters), fine-tuned on 50,000+ FEMA NIMS and ICS doctrinal elements. Runs fully offline — on a laptop, a workstation, or a thumb drive.

> *Saving Lives with AI* — [Terminus Est AI](https://terminusest.ai)

---

## Live Demo

**Try it now:** [https://demo.terminusest.ai](https://demo.terminusest.ai) *(No installation required)*

---

## Quick Start (Docker)

```bash
git clone https://github.com/terminus-est-ai/te-nims-demo
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

**Key capabilities:**
- **Doctrine-grounded responses** — every recommendation cites NIMS chapter/section
- **ICS form generation** — produces ICS-201, ICS-204, and others on demand  
- **Geo-spatial awareness** — displays locations, damage tracks, and staging areas on a live map
- **VPO provenance chain** — every decision is HMAC-signed and chain-linked for audit
- **Session memory** — remembers context within an incident session
- **Voice output** — British male voice reads responses via Piper TTS (offline)
- **Fully offline** — no cloud API calls; model runs on your hardware

---

## Demo Scenario

The demo loads the **Moore, OK EF5 Tornado (May 20, 2013)**:

- 3,417 buildings destroyed, 2,417 major damage
- Tornado track from real NWS data  
- Building damage from xView2 satellite assessment
- Pre-loaded: Plaza Towers Elementary, Moore Medical Center, Moore Fire Station 1
- Offline satellite imagery (ESRI World Imagery, z11–z16)

Type **`/demo`** in the chat to load the scenario and begin.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser  →  serve.py (Python HTTP + proxy)          │
│              ├── /api/ollama/*  →  Ollama :11434     │
│              ├── /tts           →  Piper TTS          │
│              ├── /vpo/sign      →  HMAC-SHA256 signing│
│              ├── /chain         →  VPO chain ledger   │
│              └── /demo/*        →  scenario data      │
│  Ollama   →  severian-ollama (Q4_K_M GGUF, 5.3GB)   │
└─────────────────────────────────────────────────────┘
```

- **serve.py** — single-process Python HTTP server; no frameworks
- **Ollama** — local inference server, runs alongside serve.py in Docker
- **chunks.db** — 66MB SQLite doctrine corpus (50K+ FEMA NIMS chunks)
- **MBTiles** — 21MB offline satellite tile cache for the Moore, OK area

---

## System Requirements

| | Minimum | Recommended |
|---|---|---|
| RAM | 8GB | 16GB |
| Disk | 10GB free | 20GB free |
| CPU | Any modern x86_64 | 8+ cores |
| GPU | Not required | NVIDIA CUDA (10x faster) |

**Token throughput** is governed by hardware. On CPU: ~5 tok/s. With a T4 GPU: ~44 tok/s.

---

## Model

**Base model:** [google/gemma-4-E4B-it](https://huggingface.co/google/gemma-4-E4B-it)  
**Fine-tuned weights:** [tmancino/te-nims-e4b-stage9](https://huggingface.co/tmancino/te-nims-e4b-stage9) (PEFT adapter)  
**GGUF for inference:** [tmancino/te-nims-e4b-stage9-gguf](https://huggingface.co/tmancino/te-nims-e4b-stage9-gguf) (Q4_K_M, 5.3GB)

Training: 9-stage SFT warm-start chain on FEMA NIMS doctrine, ICS procedures, and emergency management scenarios. Trained with [MLX](https://github.com/ml-explore/mlx) on Apple Silicon + Unsloth on CUDA.

---

## Sample Queries

```
"I'm Chief Martinez, Moore FD, IC. EF5 tornado just hit. What's the situation?"
"What are my immediate ICS priorities for life safety in the first operational period?"
"Generate an ICS-201 Incident Briefing for this incident."
"Show me Plaza Towers Elementary on the map."
"What is the closest staging area to Plaza Towers?"
"Recommend resource typing for urban search-and-rescue at Plaza Towers."
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
  url     = {https://github.com/terminus-est-ai/te-nims-demo},
  license = {Apache-2.0}
}
```

---

*Submitted to the [Kaggle Gemma 4 Good Hackathon](https://www.kaggle.com/competitions/gemma-4-good-hackathon) · 2026*
