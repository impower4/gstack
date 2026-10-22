/**
 * The Captain brief (lib/captain-brief.ts, gstack-owner-brief render --captain)
 * and the shared heading parser (lib/markdown-sections.ts): the five-part shape,
 * every choice rec takes shown in words, gate ids only on the agent line, the
 * rec_hash binding, and the incomplete and answered states.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capyRelayLine, renderCaptainBrief } from '../lib/captain-brief';
import { recHash, type GateList } from '../lib/gate-list';
import { findSection, headings } from '../lib/markdown-sections';
import { loadBriefInputs } from '../lib/owner-brief';

const ROOT = path.resolve(import.meta.dir, '..');
const dirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const FULL_PLAN = [
  '<!-- /autoplan restore point -->',
  '# Widget export fix',
  '',
  '## Before → after',
  '',
  'Before: `widget export` drops rows over 10k. After: every row is exported.',
  '',
  '## Why it matters',
  '',
  '- 40 users hit it weekly.',
  '',
  '## What caused this work',
  '',
  'Issue #12, quoted: "export is broken".',
  '',
  '## Big decisions',
  '',
  '1. Stream rows instead of buffering. Would flip if memory is not the cause.',
  '',
  '## Implementation plan',
  '',
  '1. Stream.',
  '',
  '## Review record',
  '',
].join('\n');

function run(plan: string, o: { answered?: boolean; urgent?: boolean } = {}): string {
  const dir = tmp('cb-run-');
  const items = [
    { id: 'd1', title: 'Split the exporter into its own module [run-1-eng-native-3]', kind: 'auto', recommended: 'a', options: [{ key: 'a', text: 'keep your direction' }, { key: 'b', text: 'accept the change', changes_plan: true }] },
    { id: 'd2', title: 'Cap memory at 256 MB', kind: 'auto', recommended: 'b', options: [{ key: 'a', text: 'no cap' }, { key: 'b', text: 'cap at 256 MB', changes_plan: true }] },
    { id: 'p1', title: 'Plan approval', kind: 'approval', recommended: 'b', options: [{ key: 'a', text: 'approve as-is' }, { key: 'b', text: 'approve with the recommended changes: d2b' }, { key: 'c', text: 'interrogate (ask questions; stays pending)' }, { key: 'd', text: `rerun every phase (to review an edited plan instead: gstack-autoplan revise --out ${dir} --plan <file>)` }, { key: 'e', text: 'reject' }] },
  ];
  const gate = { schema_version: 1, run: 'run-1', gate_rev: 2, rec_rev: 0, items } as GateList;
  fs.writeFileSync(path.join(dir, 'gate.json'), JSON.stringify(gate));
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), items.map(i => JSON.stringify({ schema_version: 1, run: 'run-1', id: `run-1-${i.id}`, label: i.id.toUpperCase(), title: i.title, options: i.options.map(x => x.key), recommended: i.recommended, kind: i.kind, gate_rev: 2,
    ...(o.answered ? { status: 'approved', chosen: i.recommended, answered_at: '2026-10-20T21:00:00Z', reply: 'rec', owner_reply: 'rec', answered_by: 'agent:GSTA-36', chosen_text: i.options.find(x => x.key === i.recommended)!.text } : { status: 'pending' }) })).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'findings.jsonl'), o.urgent ? JSON.stringify({ id: 'F9', severity: 'High', title: 'Token leaks in logs', urgent: true, suggested_owner: 'security' }) + '\n' : '');
  fs.writeFileSync(path.join(dir, 'plan-active.md'), plan);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ run: 'run-1', status: 'gate_pending', active_plan: path.join(dir, 'plan-active.md') }));
  return dir;
}

function brief(dir: string) {
  const loaded = loadBriefInputs(dir);
  if ('error' in loaded) throw new Error(loaded.error.message);
  return { ...renderCaptainBrief(loaded.inputs, { outDir: dir }), gate: loaded.inputs.gate };
}

describe('heading parser', () => {
  test('skips fenced code, ends a section at the same or a higher level, folds arrows', () => {
    const text = '# T\n## Before -> After\nreal\n### detail\nkept\n~~~\n## Why it matters\n~~~\n## Next\nx';
    expect(headings(text).map(h => h.title)).toEqual(['T', 'Before -> After', 'detail', 'Next']);
    const s = findSection(text, ['Before → after']);
    expect(s?.body).toBe('real\n### detail\nkept\n~~~\n## Why it matters\n~~~');
    expect(findSection(text, ['Why it matters'])).toBeUndefined();
    expect(findSection('## C# notes\nbody', ['C# notes'])?.body).toBe('body');
  });
});

describe('renderCaptainBrief', () => {
  test('five parts in order, header first, every choice rec takes in words, ids only on the agent line', () => {
    const b = brief(run(FULL_PLAN));
    expect(b.missing).toEqual([]);
    const t = b.text;
    expect(t.split('\n')[0]).toStartWith('**Decision needed:** approve the plan "Widget export fix". Reply **rec**');
    const order = ['### Before → after', '### Why it matters', '### What caused this work', '### Big decisions', '### What we need from you', 'Reply: **rec**'].map(s => t.indexOf(s));
    expect(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1]!))).toBe(true);
    expect(t).toContain('1. Split the exporter into its own module: keep the plan as written (a reviewer suggested changing it).');
    expect(t).toContain('2. Cap memory at 256 MB: cap at 256 MB (changes the plan).');
    const [ownerPart, agentPart] = t.split('\n---\n');
    for (const item of b.gate.items) expect(ownerPart).not.toMatch(new RegExp(`\\b${item.id}[a-e]?\\b`));
    expect(ownerPart).not.toContain('gate_rev');
    expect(ownerPart).not.toContain('gstack-autoplan revise');
    expect(agentPart).toContain(`rec_hash=${recHash(b.gate)}`);
    expect(agentPart).toContain('rec resolves to d1a d2b p1b');
  });

  test('a plan missing a section is not ready for approval and invites no reply', () => {
    const b = brief(run(FULL_PLAN.replace('## Why it matters', '## Motivation')));
    expect(b.missing).toEqual(['Why it matters']);
    expect(b.text).toStartWith('**Not ready for approval:** the plan "Widget export fix" is missing Why it matters.');
    expect(b.text).not.toContain('Reply: **rec**');
    expect(b.text).toContain('_Not written for this plan yet._');
  });

  test('an answered gate says nothing is pending; urgent findings come first', () => {
    expect(brief(run(FULL_PLAN, { answered: true })).text).toStartWith('**Nothing pending.** Already decided on 2026-10-20: approved with the recommended plan changes (“rec”).');
    expect(brief(run(FULL_PLAN, { urgent: true })).text).toStartWith('## URGENT, outside this plan');
  });

  test('long sections are capped with a pointer to the plan', () => {
    const long = FULL_PLAN.replace('- 40 users hit it weekly.', Array.from({ length: 40 }, (_, i) => `- reason ${i}`).join('\n'));
    const t = brief(run(long)).text;
    expect(t).toContain('_+ more in the plan (plan-active.md)._');
    expect(t).not.toContain('- reason 39');
  });
});

describe('gstack-owner-brief render --captain', () => {
  const cli = (args: string[]) => {
    const r = spawnSync('bun', [path.join(ROOT, 'bin', 'gstack-owner-brief'), ...args], { encoding: 'utf8', timeout: 60_000 });
    return { status: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  test('exit 0 when complete; exit 1 with CAPTAIN_BRIEF_INCOMPLETE unless --allow-incomplete', () => {
    expect(cli(['render', '--captain', '--out', run(FULL_PLAN)]).status).toBe(0);
    const dir = run(FULL_PLAN.replace('## Big decisions', '## Notes'));
    const r = cli(['render', '--captain', '--out', dir]);
    expect(r.status).toBe(1);
    expect(r.err).toContain('(CAPTAIN_BRIEF_INCOMPLETE)');
    expect(r.out).toContain('**Not ready for approval:**');
    expect(cli(['render', '--captain', '--out', dir, '--allow-incomplete']).status).toBe(0);
    const j = JSON.parse(cli(['render', '--captain', '--out', run(FULL_PLAN), '--json']).out);
    expect(j.missing).toEqual([]);
    expect(j.rec_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  test('the Capy relay line appears only under GSTACK_CAPY=1', () => {
    expect(capyRelayLine('/r', { GSTACK_CAPY: '1' })).toStartWith('RELAY: gstack-owner-brief render --captain --out /r ');
    expect(capyRelayLine('/r', {})).toBeUndefined();
  });
});
