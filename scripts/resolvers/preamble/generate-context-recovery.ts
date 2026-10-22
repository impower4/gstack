import type { TemplateContext } from '../types';

export function generateContextRecovery(ctx: TemplateContext): string {
  const binDir = ctx.paths.binDir; // env-var hosts already resolve to $GSTACK_BIN via types.ts

  // The listing lives in bin/gstack-context-recovery (#2763): worktree-isolated
  // Claude Code sessions refuse the eval and git-in-a-pipe forms the inline
  // fence used, but run one literal command. Branch-form discipline
  // (#2550/#1851) moved with it.
  return `## Context Recovery

At session start or after compaction, recover recent project context.

\`\`\`bash
${binDir}/gstack-context-recovery
\`\`\`

If artifacts are listed, read the newest useful one. If \`LAST_SESSION\` or \`LATEST_CHECKPOINT\` appears, give a 2-sentence welcome back summary. If \`RECENT_PATTERN\` clearly implies a next skill, suggest it once.

**Cross-session decisions.** Honor listed \`ACTIVE DECISIONS\` and their rationale; do not silently re-litigate them, and announce planned reversals. Use \`${binDir}/gstack-decision-search\` for past-decision questions. Log DURABLE decisions by you or the user (architecture, scope, tool/vendor choice, reversal; not trivial or turn-level choices) with \`${binDir}/gstack-decision-log\` (\`--supersede <id>\` for reversals). Reliable and local; gbrain not required.`;
}
