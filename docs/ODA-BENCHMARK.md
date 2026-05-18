# TE NIMS Operational Decision Accuracy (ODA) Benchmark

> **Status: Developing benchmark — not yet peer-reviewed.**
> This document describes an internal evaluation methodology developed to measure
> doctrine-grounded decision quality. Results should be interpreted as an internal
> signal, not a general-purpose or externally-validated benchmark.

---

## Overview

The **Operational Decision Accuracy (ODA)** score measures how well TE NIMS produces
correct, doctrine-grounded responses to realistic Incident Commander questions. A score
of **0.916** was achieved by the `te-nims-e4b-stage9` checkpoint on a 52-case hand-curated
evaluation set.

---

## Methodology

### Test Set Construction

52 test cases were constructed by the TE NIMS team, with calibration by a qualified
NIMS/ICS domain expert with 40+ years of emergency management experience. Each case
consists of:

- **Scenario context** — incident type, operational period, IC role, jurisdiction
- **Question** — a realistic IC query (e.g., "What are my life-safety priorities for the
  first operational period?", "Generate an ICS-201 for this incident", "What resource
  typing applies to urban USAR at this location?")
- **Reference answer** — the correct NIMS/ICS doctrine response, including the
  authoritative source (e.g., NIMS 2017, ICS-100, specific form field definitions)

Cases span:
- Natural disasters (tornado, hurricane, earthquake, flood)
- USAR / mass casualty response
- Unified Command establishment
- ICS form generation (ICS-201, 202, 204, 213, 215)
- Resource typing and ordering
- Mutual aid and EMAC coordination
- Demobilization planning

### Scoring Rubric

Each response is scored across three dimensions (0–1 scale each), averaged:

| Dimension | Description | Weight |
|-----------|-------------|--------|
| **Doctrine Accuracy** | Does the answer match the correct NIMS/ICS guidance? Penalizes hallucinated procedures or role descriptions. | 40% |
| **Source Citation** | Does the response cite the applicable NIMS/ICS reference (e.g., "per ICS-201, Section 3" or "per NIMS Doctrine 2017, Chapter 4")? | 30% |
| **Operational Specificity** | Is the guidance actionable at IC level, or is it generic? Does it reflect the specific incident context? | 30% |

Final ODA = weighted average across all 52 cases.

### Evaluation Process

- Responses generated with temperature=0 (greedy decoding) for reproducibility
- Evaluated by the domain expert reviewer against the reference answer
- Reviewer is the calibration authority — no external evaluators used at this stage
- Evaluation was conducted on a held-out split where possible, but significant overlap
  exists between the training corpus and evaluation scenarios due to the narrow domain

---

## Results

| Model checkpoint | ODA Score | Cases |
|-----------------|-----------|-------|
| `te-nims-e4b-stage3` (SFT baseline) | 0.741 | 52 |
| `te-nims-e4b-stage5` | 0.823 | 52 |
| `te-nims-e4b-stage9` **(production)** | **0.916** | 52 |
| `te-nims-e4b-stage10` (GRPO, collapsed) | — | — |

Stage 10 GRPO training was attempted but collapsed at step 7 (policy collapse,
reward variance → 0.0004, model saturation). Stage 9 is the final production
checkpoint.

---

## Limitations and Honest Caveats

1. **Single reviewer** — all scoring was performed by one domain expert. Inter-rater
   reliability has not been established.

2. **Train-test overlap** — the evaluation set was constructed from the same NIMS/ICS
   doctrine corpus used for training. True generalization performance on out-of-distribution
   incidents is unknown.

3. **No confidence intervals** — with 52 cases the benchmark has limited statistical power.
   ±CI estimates have not been computed. A difference of 3–4 cases (~6–8%) is within noise.

4. **No adversarial or red-team cases** — the benchmark does not include cases designed
   to probe failure modes, hallucination under pressure, or multi-turn degradation.

5. **English-only, US-jurisdiction** — all cases reflect US NIMS/ICS doctrine. Performance
   on international emergency management frameworks has not been tested.

6. **Evaluator = trainer** — the domain expert who calibrated the test set also provided
   feedback during training. Bias from this overlap cannot be fully excluded.

---

## Planned Improvements

- [ ] Multi-judge inter-rater reliability study (target: 3 qualified reviewers)
- [ ] Separate RAG-off vs. RAG-on sub-scores (currently conflated)
- [ ] Adversarial and out-of-distribution test cases
- [ ] Automated evaluation harness with LLM-as-judge for scalability
- [ ] CI computation via bootstrap resampling
- [ ] Post-hackathon external validation with partner emergency management agencies

---

## Citation

If you reference this benchmark, please note its developing status:

```bibtex
@misc{te-nims-oda-2026,
  title   = {TE NIMS Operational Decision Accuracy (ODA) Benchmark},
  author  = {Terminus Est AI},
  year    = {2026},
  note    = {Internal benchmark, not peer-reviewed. Developing methodology.},
  url     = {https://github.com/TerminusEstAI/te-nims-demo/blob/main/docs/ODA-BENCHMARK.md}
}
```

---

*This benchmark is a work in progress. We are committed to honest measurement of our
model's capabilities and limitations. Feedback from the emergency management community
is welcome.*

*Gemma is a trademark of Google LLC.*
