/**
 * captain-brief — the plan-approval ask in the shape Capy Captains relay to
 * their person (capy/skill/gstack/captain.md): a two-line header with the
 * one-word reply, then Before → after, Why it matters, What caused this work,
 * Big decisions (each read from the reviewed plan through the shared heading
 * parser) and What we need from you (built from gate.json: every choice `rec`
 * takes, in words). Gate ids, gate_rev and rec_hash appear only on the last
 * line, which is for the relaying agent. A plan missing a section yields a
 * brief that says it is not ready for approval and has no reply invitation
 * (CAPTAIN_BRIEF_INCOMPLETE). Called by bin/gstack-owner-brief render --captain.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recHash, type GateItem } from './gate-list';
import { renderUrgentBlock } from './headless-artifacts';
import { findSection, firstTitle } from './markdown-sections';
import type { BriefInputs } from './owner-brief';

export const BRIEF_SECTIONS = [
  { title: 'Before → after', aliases: ['Before → after', 'Before -> after', 'Before and after', 'Before/after'] },
  { title: 'Why it matters', aliases: ['Why it matters', 'Why this matters'] },
  { title: 'What caused this work', aliases: ['What caused this work', 'What caused us to work on this', 'What caused this', 'Trigger'] },
  { title: 'Big decisions', aliases: ['Big decisions', 'Big decisions we made', 'Key decisions'] },
] as const;
const SECTION_LINES = 24;
const SECTION_CHARS = 3000;

/** The plan text the gate approves: the run's active (reviewed) plan unless an amendment is pending, else the export. */
export function reviewedPlan(outDir: string, run?: Record<string, any>): { file?: string; text: string; sha: string } {
  const active = typeof run?.active_plan === 'string' && run?.status !== 'amend_pending' ? run.active_plan : undefined;
  const candidates = [active, path.join(outDir, 'plan-active.md'), path.join(outDir, 'plan.md')].filter((f): f is string => !!f);
  const file = candidates.find(f => fs.existsSync(f));
  const text = file ? fs.readFileSync(file, 'utf8') : '';
  const sha = typeof run?.plan_reality?.plan_sha256 === 'string' ? run.plan_reality.plan_sha256.slice(0, 12) : text ? createHash('sha256').update(text).digest('hex').slice(0, 12) : 'unknown';
  return { file, text, sha };
}

const stripRef = (t: string) => t.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
const OPTION_WORDS: Record<string, string> = {
  'keep your direction': 'keep the plan as written (a reviewer suggested changing it)',
  'accept the change': "make the reviewer's change",
};
const plainOption = (t: string) => {
  const s = t.replace(/\s*\([^)]*gstack-autoplan[^)]*\)/g, '').trim();
  if (/^approve with the recommended changes\b/.test(s)) return 'approve, with the plan changes marked below';
  if (s === 'approve as-is') return 'approve the plan as reviewed';
  return OPTION_WORDS[s] ?? s;
};
const P1_DONE: Record<string, string> = { a: 'approved as reviewed', b: 'approved with the recommended plan changes', c: 'questions asked, still open', d: 'sent back for another review round', e: 'rejected' };
const clip = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…');

function capped(body: string, planPath: string): string {
  const lines = body.split('\n');
  let out = lines.slice(0, SECTION_LINES).join('\n');
  if (out.length > SECTION_CHARS) out = out.slice(0, SECTION_CHARS).replace(/\s+\S*$/, '') + ' …';
  const hidden = lines.length - Math.min(lines.length, SECTION_LINES);
  return hidden > 0 || out.length < body.length ? `${out}\n\n_+ more in the plan (${path.basename(planPath)})._` : out;
}

export interface CaptainBrief { text: string; missing: string[]; pending: boolean; recHash: string }

export function renderCaptainBrief(inputs: BriefInputs, o: { outDir: string }): CaptainBrief {
  const plan = reviewedPlan(o.outDir, inputs.run);
  const title = firstTitle(plan.text) ?? 'this plan';
  const list = inputs.gate;
  const hash = recHash(list);
  const p1 = list.items.find(i => i.id === 'p1');
  const rowOf = (id: string) => inputs.decisions.filter(d => d.gate_rev === list.gate_rev).find(d => (d.label ?? '').toLowerCase() === id);
  const p1Row = p1 ? rowOf('p1') : undefined;
  const pending = !p1Row || p1Row.status === 'pending';
  const sections = BRIEF_SECTIONS.map(s => ({ title: s.title, found: findSection(plan.text, [...s.aliases]) }));
  const missing = sections.filter(s => !s.found || !s.found.body.trim()).map(s => s.title);
  const urgent = inputs.findings.some(r => r.urgent === true || r.outside_plan === true) ? [renderUrgentBlock(inputs.findings).trimEnd(), ''] : [];
  const items = list.items.filter(i => i.id !== 'p1');
  const recText = (i: GateItem) => plainOption(i.options.find(x => x.key === i.recommended)?.text ?? i.recommended);

  let header: string[];
  if (!pending) {
    header = [`**Nothing pending.** Already decided${p1Row?.answered_at ? ` on ${p1Row.answered_at.slice(0, 10)}` : ''}: ${P1_DONE[p1Row?.chosen ?? ''] ?? 'answered'}${p1Row?.owner_reply ?? p1Row?.reply ? ` (“${p1Row?.owner_reply ?? p1Row?.reply}”)` : ''}.`];
  } else if (missing.length) {
    header = [`**Not ready for approval:** the plan "${title}" is missing ${missing.join(', ')}. The thread will add them and send this again; do not approve from this draft.`];
  } else {
    header = [
      `**Decision needed:** approve the plan "${title}". Reply **rec** to take every recommendation (recommended), or say in words what to change.`,
      `${items.length ? `${items.length} choice${items.length === 1 ? '' : 's'} below; rec takes the recommended answer for each.` : 'No open choices besides the approval itself.'} Nothing is built until you answer.`,
    ];
  }

  const body = sections.flatMap(s => [`### ${s.title}`, '', s.found?.body.trim() ? capped(s.found.body.trim(), plan.file ?? 'plan.md') : '_Not written for this plan yet._', '']);
  const need: string[] = ['### What we need from you', ''];
  if (!pending) need.push('Nothing. This gate is answered.', '');
  else {
    need.push(`One decision: approve the plan.`, '');
    need.push(`- **rec (recommended):** ${p1 ? plainOption(p1.options.find(x => x.key === p1.recommended)?.text ?? 'approve') : 'approve'}${items.length ? ', taking these recommendations:' : '.'}`);
    items.forEach((i, n) => need.push(`  ${n + 1}. ${stripRef(i.title)}: ${recText(i)}${i.options.find(x => x.key === i.recommended)?.changes_plan ? ' (changes the plan)' : ''}.`));
    const example = items.find(i => i.options.length > 1);
    const alt = example?.options.find(x => x.key !== example.recommended);
    need.push(`- **Change something:** say which choice and what you want instead, in words${example && alt ? ` (for example "${clip(stripRef(example.title), 60)}: ${plainOption(alt.text)}")` : ''}. A change that alters the plan reopens its review before anything is built.`);
    need.push('- **Reject:** nothing is built.', '');
    if (!missing.length) need.push('Reply: **rec**', '');
  }
  const tokens = list.items.map(i => `${i.id}${i.recommended}`).join(' ');
  const trailer = `_For the relaying agent, not the person:_ run ${list.run}, gate_rev=${list.gate_rev}, rec_hash=${hash}; rec resolves to ${tokens}; plan ${plan.file ?? '(missing)'} (sha256 ${plan.sha}). Answer with ` +
    `\`gstack-autoplan answer --out ${o.outDir} --gate-rev ${list.gate_rev} --reply rec --rec-hash ${hash} --by agent:<id> --owner-reply "<their exact words>"\`, then \`gstack-approvals import --autoplan ${o.outDir} --by <name>\`.`;
  const text = [...urgent, ...header, '', ...body, ...need, '---', '', trailer, ''].join('\n');
  return { text, missing, pending, recHash: hash };
}

/** The extra line a gate-producing command prints under Capy (GSTACK_CAPY=1): the owner-facing render to relay. */
export function capyRelayLine(outDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GSTACK_CAPY !== '1') return undefined;
  return `RELAY: gstack-owner-brief render --captain --out ${outDir} (Capy: send it to your Captain, or to the person when you report to none; it carries the rec_hash to answer with)`;
}
