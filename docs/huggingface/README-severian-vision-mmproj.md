---
license: apache-2.0
tags:
  - gemma4
  - gguf
  - mmproj
  - multimodal
  - vision
---

# Severian Vision mmproj

Multimodal projector artifact for the TE NIMS vision sidecar.

## What this repo is

This repo contains the `mmproj` file required by `llama.cpp` / `llama-server`
to run the `severian-vision` multimodal model.

## Required companion repo

- `tmancino/severian-vision-gguf`

You need both:

- `severian-vision-q4_k_m.gguf`
- `mmproj-severian-vision.gguf`

## Runtime use

The public TE NIMS demo uses this file together with the vision GGUF in the
`llama-server` sidecar.

## Files

- `mmproj-severian-vision.gguf`
- `SHA256SUMS`

## Notes

- This repo exists to make the runtime dependency explicit and reproducible.
- Keep versioning aligned with the paired vision GGUF repo.
