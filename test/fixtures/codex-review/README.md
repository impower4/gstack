# Captured `codex review --base` output (#2769)

Captured from the real Codex CLI binary, `codex-cli 0.160.0` (npm
`@openai/codex`), running `codex review --base main -c 'sandbox_mode="read-only"'`
on a branch with one commit plus an uncommitted edit.

The model turn is synthetic: no OpenAI credential was available, so the CLI
was pointed at a local Responses-API stub (`model_providers.mock`, `wire_api =
"responses"`) that returned the reviewer rubric's JSON. Everything after that
JSON (parsing, rendering, stdout) is the CLI's own code path.

- `clean-review.stdout.txt`: the stub returned
  `{"findings":[],"overall_correctness":"patch is correct","overall_explanation":"No actionable correctness issues were found in the changed retry helper or its tests.","overall_confidence_score":0.88}`.
  The CLI prints only `overall_explanation`; `overall_correctness` and the
  confidence score never reach stdout, so a clean review is untagged prose.
- `p2-review.stdout.txt`: one finding titled `[P2] ...`. Severity tags appear
  only inside finding titles.

The request the CLI sent asked the model to run `git diff <merge-base>`
(working tree against the merge base: branch commits plus uncommitted tracked
edits, not untracked files). The `--base` path has no structured verdict on
stdout, so the gate cannot grant PASS to untagged output.
