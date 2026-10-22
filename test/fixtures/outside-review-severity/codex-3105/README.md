# Codex reply shapes from #3105

Issue #3105 reports 13 Codex consult/challenge replies that the outside-review
helper summarised as `VERDICT: clean / FINDINGS: none`. The issue describes the
forms but does not include the replies, so these files are synthesized from the
forms it documents (`1. **P1 — x**`, `1. P2 — x`, a bare `P2 —` label, a final
`Verdict: not ready (...)` line, and one `ready` reply with a single P3), plus
negative controls: a real no-findings reply and P1 tokens quoted inside code.
`test/outside-review-unparsed-severity.test.ts` holds the expected verdicts.
