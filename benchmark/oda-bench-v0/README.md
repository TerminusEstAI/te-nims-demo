# TE NIMS ODA Bench v0

TE NIMS ODA Bench v0 is the first public packaging of the TE NIMS internal
Operational Decision Accuracy benchmark.

It contains:

- `cases.jsonl` — the 52 published benchmark prompts
- `BENCHMARK-METADATA.json` — benchmark description, scope, and provenance
- `RESULTS.json` — the currently documented direct-model and full-harness
  results

## Scope

This benchmark is intended for **doctrine-grounded incident-command decision
support** in the narrow TE NIMS demo setting. It is not a general emergency
management benchmark and it is not a safety certification artifact.

## Important distinction

Two different scores are associated with Stage 9 in this repo:

- `0.7108` — direct Stage 9 checkpoint eval on the 52 published cases
- `0.916` — full TE NIMS harness eval on the same 52 cases, with retrieval and
  workflow tooling enabled

Those numbers should not be conflated.

## Known limitations

- single-reviewer internal scoring
- significant train/eval overlap risk
- no published confidence intervals
- no adversarial or OOD slice in this version
- full-harness score is documented in repo materials, but the checked-in raw
  harness run artifact is not currently included in this bundle

## Case file integrity

- `cases.jsonl` SHA-256:
  `973d5e0fd4361320abddfe824532d3b8aae34e119f51e4c99a219cb08743e640`
