---
license: apache-2.0
base_model: google/gemma-4-E4B-it
tags:
  - gemma4
  - lora
  - adapter
  - emergency-management
  - nims
  - ics
---

# TE NIMS Stage 9 Adapter

Stage 9 training adapter for the TE NIMS text model built on
`google/gemma-4-E4B-it`.

## What this repo is

This repo is the adapter and training-lineage artifact for TE NIMS Stage 9.
It is not the deployable model used directly by the public demo.

For deployment and local inference, use the matching GGUF repo instead:

- Deployment GGUF: `tmancino/te-nims-e4b-stage9-gguf`

## Intended use

- Training lineage and stage documentation
- Adapter inspection
- Conversion into other runtime formats

## Not intended use

- Direct Ollama deployment without conversion
- Treating this repo as a drop-in GGUF or standalone inference artifact

## Runtime relationship

The TE NIMS demo serves the Stage 9 text path through the deployable GGUF:

- Runtime wrapper: `severian-ollama`
- Public inference artifact: `tmancino/te-nims-e4b-stage9-gguf`

## Notes

- Keep the adapter card and GGUF card aligned on stage naming and lineage.
- Do not describe this repo as the live demo deployment artifact.
