import type { TemplateContext } from '../types';

export function generateSearchBeforeBuildingSection(ctx: TemplateContext): string {
  return `## Search Before Building

Before building anything unfamiliar, **search first.** See \`${ctx.paths.skillRoot}/ETHOS.md\`.
- **Layer 1** (tried and true) — don't reinvent. **Layer 2** (new and popular) — scrutinize. **Layer 3** (first principles) — prize above all.

**The reuse ladder — before writing new code, stop at the first rung that holds:**
1. A helper, util, or pattern already in this repo — re-implementing what's a few files over is the most common slop.
2. The standard library.
3. A native platform feature (CSS over JS, DB constraint over app code, \`<input type="date">\` over a picker lib).
4. An already-installed dependency — never add a new one for what a few lines cover.

Then build the complete version of what remains.

**Bug fixes hit root cause, not symptom:** one guard in the shared function beats a guard in every caller — grep the callers, fix it once where they all route through.

**Eureka:** When first-principles reasoning contradicts conventional wisdom, name it and log:
\`\`\`bash
GSTACK_STATE_ROOT=$(${ctx.paths.binDir}/gstack-paths --get GSTACK_STATE_ROOT); : "\${GSTACK_STATE_ROOT:?gstack-paths failed; reinstall with ./setup or /gstack-upgrade}"
BRANCH=$(${ctx.paths.binDir}/gstack-slug --get BRANCH 2>/dev/null)
jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg skill "SKILL_NAME" --arg branch "$BRANCH" --arg insight "ONE_LINE_SUMMARY" '{ts:$ts,skill:$skill,branch:$branch,insight:$insight}' >> "$GSTACK_STATE_ROOT/analytics/eureka.jsonl" 2>/dev/null || true
\`\`\``;
}

