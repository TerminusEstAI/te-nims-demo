---
license: apache-2.0
pipeline_tag: image-text-to-text
library_name: gguf
tags:
  - gemma4
  - gguf
  - multimodal
  - vision
  - emergency-management
  - nims
---

# Severian Vision GGUF

Deployment-ready GGUF for the TE NIMS multimodal vision sidecar.

## What this repo is

This repo contains the quantized vision model used by the TE NIMS demo's
`llama-server` sidecar. It is not sufficient by itself: the matching mmproj
artifact is also required at runtime.

## Required companion repo

- `tmancino/severian-vision-mmproj`

You need both:

- `severian-vision-q4_k_m.gguf`
- `mmproj-severian-vision.gguf`

## Runtime use

The public demo serves this model as:

- Runtime name: `severian-vision`
- Intended runtime: `llama-server` / `llama.cpp`

The GCP/systemd deployment points `llama-server` at this file and the matching
mmproj file.

## Files

- `severian-vision-q4_k_m.gguf`
- `SHA256SUMS`

## Notes

- This is the deployable vision inference artifact.
- It should be versioned in lockstep with the matching projector repo.
