# TE NIMS — AI Decision Support for Civilian Emergency Management
### Kaggle Gemma 4 Good Hackathon — Technical Write-Up

**Track:** Global Resilience  
**Live Demo:** https://demo.terminusest.ai  
**Code:** https://github.com/TerminusEstAI/te-nims-demo  
**Model:** https://huggingface.co/tmancino/te-nims-e4b-stage9-gguf  
**Video:** *(link — see submission)*  
**License:** CC BY 4.0

---

## The Problem

Incident Commanders (ICs) managing civilian disasters operate under extreme cognitive load. In the first operational period of a mass-casualty event — a tornado, earthquake, or industrial accident — a single IC must simultaneously:

- Establish Unified Command and ICS organizational structure
- Account for life-safety priorities across dozens of agencies
- Generate required ICS forms (201, 202, 204, 213) for documentation
- Locate critical infrastructure (schools, hospitals, staging areas)
- Issue resource typing requests against the National Incident Management System

All of this must happen in minutes, with no time for reference material, using the exact terminology and structure required by NIMS doctrine. A wrong decision or a missed ICS form delays mutual aid, exposes the IC to legal liability, and costs lives.

**We built TE NIMS out of 40 years of disaster management experience. We have watched ICs fail — not because they were incompetent, but because the cognitive burden is inhuman. AI will change this.**

---

## What TE NIMS Is

TE NIMS is an **agentic AI harness** for the Incident Command Post. It runs a fine-tuned TE NIMS LLM (based on Gemma 4 E4B) that acts as a doctrine-grounded decision support agent for the IC. It is not a chatbot — it is a full agentic loop with tools, a provenance chain, voice I/O, and geo-spatial awareness.

The live demo at **https://demo.terminusest.ai** simulates the IC arriving at the **Moore, Oklahoma EF5 tornado (May 20, 2013)** — a real event with real damage data, real school locations, and real NWS track data.

---

## Technical Implementation

### Fine-Tuned Model: TE NIMS E4B Stage 9

The base model is Gemma 4 E4B (4B parameter dense edge model), fine-tuned through a 9-stage SFT warm-start chain on:
- FEMA National Incident Management System (NIMS) doctrine
- Incident Command System (ICS) field manuals and form specifications
- After-action reports from real disaster incidents
- 50,000+ curated doctrinal elements

**ODA Score: 0.916** on the 52-case TE NIMS internal benchmark (Operational Decision Accuracy — see `docs/ODA-BENCHMARK.md` for full methodology and honest limitations). This is a developing internal benchmark, not peer-reviewed.

The model is available as a 5.3GB Q4_K_M GGUF at [tmancino/te-nims-e4b-stage9-gguf](https://huggingface.co/tmancino/te-nims-e4b-stage9-gguf) and runs via Ollama with no cloud API calls.

### Agentic ReAct Loop

Every query passes through a multi-step **ReAct (Reason + Act)** loop before responding:

```
IC query
  → Model reasons about what data is needed
  → Model emits <tool_call> to fetch live context
  → Tools execute: doctrine RAG, geo-pin, damage overlay, scenario data
  → Model grounds final answer in doctrine + live data
  → Response with ICS citations
```

Available tools: `get_scenario_info`, `search_doctrine`, `pin_map_location`, `zoom_map`, `toggle_map_layer`. The model never answers from training memory alone — it always retrieves and cites.

### Gemma 4 Multimodal Vision

The demo includes a **standalone llama-server sidecar** running `severian-vision` — a multimodal fine-tune with the Gemma 4 mmproj. ICs can:
- Photograph hand-drawn org charts on whiteboards → model redraws to NIMS doctrine in ASCII or structured format
- Upload field damage photos → model identifies building types and NIMS-relevant hazards
- Scan QR code with any phone → images inject directly into the desktop IC session

### VPO Provenance Chain

Every chat turn produces a signed block in the **VPO (Verified Provenance Object) chain** — an append-only HMAC-linked audit ledger. Every decision the IC made, every doctrine citation, every tool call is recorded with a cryptographic link to the previous block. This is the foundation for post-incident legal documentation and after-action review.

*Note: In this demo the signing key is a labeled demo identity. Production deployment uses agency-held asymmetric keys.*

### Geo-Spatial Awareness

The map panel displays:
- Real NWS EF5 tornado damage track (Moore, OK 2013)
- xView2 satellite building damage classification (3,417 destroyed, 2,417 major damage)
- AI-pinned locations as the model references them (Plaza Towers Elementary, staging areas, fire stations)
- USGS National Map base imagery (public domain)

### PDF RAG and NIMS Library

66MB SQLite doctrine corpus with nomic-embed-text embeddings. Any NIMS/ICS PDF can be dragged into the chat for immediate RAG — chunks are extracted, embedded, and queried in real time. The Library tab contains all major FEMA NIMS doctrine and ICS form specifications.

### Offline / Edge Deployment

The entire system runs on a single machine with no cloud API calls:
- **Ollama** serving the Q4_K_M GGUF (~5GB, 8GB VRAM minimum)
- **Piper TTS** for offline British-English voice responses
- **Web Speech API** for push-to-talk voice input
- **MBTiles** offline satellite tile cache (21MB, Moore/OKC metro)

`docker compose up` pulls the model from HuggingFace on first boot and starts everything. No accounts, no API keys, no internet required after first run.

### Sentence-Streaming TTS

TTS responses begin speaking after the **first sentence** arrives from the model — not after the full response completes. This cuts perceived latency from 3-8 seconds to under 1 second for the IC's voice feedback loop.

---

## The Guided Demo

The live site includes a **19-step guided tutorial** that walks through every capability with pre-loaded queries:

1. IC situational awareness on arrival
2. Voice mode activation
3. Initial ICS-201 Incident Briefing generation *(voice reads the form)*
4. ICS Forms tab — explain ICS-205
5. ICS priorities according to doctrine *(voice mutes before long response)*
6. Plaza Towers Elementary school location *(geo-pin fired)*
7. NIMS Library RAG — search team roles
8. Org chart upload intro
9. QR code mobile photo upload
10. Drag photo to chat → ASCII redraw
11. Gemma 4 doctrinal org chart redraw
12. /save → HTML artifact
13. Building damage by type (geo-aware query)
14. Resource typing at Plaza Towers
15. Geo-spatial informational step
16. Closest staging area
17. Show Moore Fire Station 1
18. Odin data retrieval / Gold parquets
19. Dedication and close

---

## Infrastructure

| Component | Technology |
|---|---|
| Web server | Python `ThreadingTCPServer`, supervisord-managed |
| LLM inference | Ollama + severian-ollama (text), llama-server sidecar (vision) |
| TTS | Piper TTS, sentence-streaming queue |
| STT | Web Speech API (push-to-talk) |
| RAG | pypdfium2, nomic-embed-text, SQLite WAL |
| Maps | Leaflet.js, USGS National Map, MBTiles |
| Provenance | HMAC-SHA256 chain, JSONL server mirror, IndexedDB client |
| TLS | Caddy (auto-cert) |
| Process mgmt | supervisord with stopasgroup/killasgroup |
| GPU | NVIDIA Tesla T4 (GCP n1-standard-4) |

---

## Reproducibility

```bash
git clone https://github.com/TerminusEstAI/te-nims-demo
cd te-nims-demo
docker compose up
# → Downloads 5GB model from HuggingFace, starts everything
# → Open http://localhost:8765
```

All dependencies are pinned. The model is public. The demo scenario data (Moore tornado) is bundled. A cold install on a machine with 8GB RAM and a CUDA GPU reaches the demo in under 10 minutes.

---

## Attribution

- **Gemma 4 E4B** — Google LLC, Apache 2.0. Gemma is a trademark of Google LLC.  
- **FEMA NIMS Doctrine** — U.S. Department of Homeland Security, public domain  
- **xView2 Building Damage Dataset** — DIUx, CC BY 4.0  
- **USGS National Map imagery** — U.S. federal government, public domain  

---

*Terminus Est AI · "Saving lives with AI" · Submitted to the Kaggle Gemma 4 Good Hackathon, May 2026*
