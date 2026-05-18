# TE NIMS Hugging Face Artifact Layout

This document is the source of truth for the public Hugging Face artifacts
used by the TE NIMS demo and its GCP deployment.

The demo serves two model paths:

1. Text inference via Ollama (`severian-ollama`)
2. Vision inference via `llama-server` (`severian-vision`)

Those runtime names should map cleanly to public, reproducible Hugging Face
artifacts.

## Current public artifacts

### 1. Training adapter

- Repo: `tmancino/te-nims-e4b-stage9`
- Purpose: LoRA adapter / training artifact for Stage 9
- Consumer: training, lineage, research, not direct demo deployment
- Card draft: [`docs/huggingface/README-te-nims-e4b-stage9.md`](huggingface/README-te-nims-e4b-stage9.md)

### 2. Text inference artifact

- Repo: `tmancino/te-nims-e4b-stage9-gguf`
- Runtime file: `nims-e4b-stage9-q4_k_m.gguf`
- Consumer: demo text path via Ollama
- Runtime name: `severian-ollama`
- Card draft: [`docs/huggingface/README-te-nims-e4b-stage9-gguf.md`](huggingface/README-te-nims-e4b-stage9-gguf.md)

This is the artifact downloaded by [`entrypoint.sh`](../entrypoint.sh) on
first boot and wrapped by [`Modelfile`](../Modelfile).

## Published vision artifacts

The live demo also serves a separate vision model:

- Runtime name: `severian-vision`
- Runtime files:
  - `severian-vision-q4_k_m.gguf`
  - `mmproj-severian-vision.gguf`

Those files are referenced directly by
[`web/llama-vision.service`](../web/llama-vision.service).

The deployment is made reproducible by publishing them as two public Hugging
Face repos:

### 3. Vision inference artifact

- Repo: `tmancino/severian-vision-gguf`
- Required files:
  - `severian-vision-q4_k_m.gguf`
  - `README.md`
  - `SHA256SUMS`
  - optional `LICENSE`
- Card draft: [`docs/huggingface/README-severian-vision-gguf.md`](huggingface/README-severian-vision-gguf.md)

### 4. Vision projector artifact

- Repo: `tmancino/severian-vision-mmproj`
- Required files:
  - `mmproj-severian-vision.gguf`
  - `README.md`
  - `SHA256SUMS`
  - optional `LICENSE`
- Card draft: [`docs/huggingface/README-severian-vision-mmproj.md`](huggingface/README-severian-vision-mmproj.md)

## Why split vision into two repos

- The runtime already treats model and projector as separate files.
- `llama.cpp` users need both, and the split makes that explicit.
- Checksums and upgrades become simpler.
- A projector can change without forcing a model repo rewrite.

If desired, both files can also be mirrored in a combined release repo later,
but the split layout should be considered canonical.

## Runtime-to-artifact map

| Runtime surface | Local runtime name | Public HF repo | Required file(s) |
|---|---|---|---|
| Text chat | `severian-ollama` | `tmancino/te-nims-e4b-stage9-gguf` | `nims-e4b-stage9-q4_k_m.gguf` |
| Vision chat | `severian-vision` | `tmancino/severian-vision-gguf` | `severian-vision-q4_k_m.gguf` |
| Vision projector | `severian-vision` | `tmancino/severian-vision-mmproj` | `mmproj-severian-vision.gguf` |

## Publish checklist

- Use deployable filenames exactly as referenced by runtime code.
- Include SHA-256 checksums in every repo.
- Include base-model lineage.
- State quantization level and intended runtime.
- State clearly whether the artifact is training-only or deployment-ready.
- Do not include local filesystem paths or internal-only metadata.
- Keep license metadata aligned across GitHub and Hugging Face.
