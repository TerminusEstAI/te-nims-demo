---
license: apache-2.0
pipeline_tag: text-generation
library_name: gguf
tags:
  - gemma4
  - gguf
  - emergency-management
  - nims
  - ics
  - offline
---

# TE NIMS Stage 9 GGUF

Deployment-ready GGUF for the TE NIMS text inference path used by the public
demo and local Docker install.

## What this repo is

This repo contains the quantized text inference artifact for TE NIMS Stage 9.
It is the deployable counterpart to the Stage 9 adapter/training repo:

- Training adapter: `tmancino/te-nims-e4b-stage9`
- Deployable GGUF: `tmancino/te-nims-e4b-stage9-gguf`

## Runtime use

The TE NIMS demo downloads this file on first boot and registers it with
Ollama as `severian-ollama`.

- Runtime wrapper: `severian-ollama`
- Intended runtime: Ollama / llama.cpp-compatible GGUF serving
- Demo code: `github.com/TerminusEstAI/te-nims-demo`

## Files

- `nims-e4b-stage9-q4_k_m.gguf`
- `SHA256SUMS`

## Base model

- Base model: `google/gemma-4-E4B-it`

## Evaluation notes

- Direct Stage 9 checkpoint eval: `0.7108` on the 52-case internal gate
- Full TE NIMS harness eval: `0.916` on the same internal bench with
  retrieval and workflow tooling enabled

These two numbers refer to different evaluation modes and should not be
presented as the same thing. This GGUF repo is the deployable text inference
artifact, not the full harness.

## Notes

- This repo is for deployment and inference.
- For training lineage or adapter-level inspection, use
  `tmancino/te-nims-e4b-stage9`.
