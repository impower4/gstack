import type { TemplateContext } from '../types';

/**
 * Steady-state STATUS-line rules only (token-reduction Phase 2). The upgrade
 * flow, feature discovery, and every one-time onboarding prompt moved into
 * bin/gstack-skill-start's instruction-emission layer — their text is emitted
 * at runtime only when the gate fires, wrapped in GSTACK_INSTRUCTION blocks
 * the fence prose scopes and the model follows.
 */
export function generateUpgradeCheck(ctx: TemplateContext): string {
  return `If \`PROACTIVE\` is \`false\`, do not auto-invoke or suggest skills, including by asking whether to run one. Only run skills the user explicitly invokes.

If \`SKILL_PREFIX\` is \`"true"\`, suggest/invoke \`/gstack-*\` names. Disk paths stay \`${ctx.paths.skillRoot}/[skill-name]/SKILL.md\`.`;
}
