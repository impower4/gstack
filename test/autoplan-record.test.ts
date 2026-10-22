/**
 * `gstack-autoplan submit --record` (plan B1b, item 7): a phase reviewed by a
 * host subagent binds from its own record. Accepted shapes are the canonical
 * fence, an exact `No findings.` line, or exactly one findings table or
 * severity-tagged list; anything else, or two shapes, is refused. A record
 * without the INPUT receipt binds only with `--attest <reason>` and an
 * explicit `--attempt` (receipt: attested); a wrong receipt always refuses.
 * `--voice outside --unavailable|--failed` closes the phase native_only, and
 * the terminal outcome is journaled so `next` and `resume` never redispatch
 * or resurrect it. Runs on the simulated Capy host.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { capyRunner, readJsonl, readRunJson, writePlan } from './helpers/autoplan-capy';
import { boundOf, resultOf } from './helpers/autoplan-run-fixture';

const r = capyRunner();
afterAll(() => r.cleanup());
let n = 0;
function start(): string {
  const dir = path.join(r.host.base, `rec${++n}`);
  const plan = writePlan(dir);
  const out = path.join(dir, 'run');
  const first = r.ap(['next', '--out', out, '--plan', plan, '--no-ui']);
  if (first.status !== 0) throw new Error(`first next failed: ${first.stderr}\n${first.stdout}`);
  return out;
}
const write = (out: string, name: string, text: string) => { const f = path.join(path.dirname(out), name); fs.writeFileSync(f, text); return f; };
const snapshotOf = (out: string, phase = 'ceo') => readRunJson(out).phases[phase].snapshot as string;

const TABLE = `# CEO review (hand-run subagent)

Prose about the plan.

| # | Severity | Finding | File | Fix |
|---|---|---|---|---|
| 1 | High | Retry cap is unbounded on restart | lib/worker.ts:10 | persist the cap |
| 2 | Medium | Split persistence change into its own plan | | split it |
`;
const list = (sha: string) => `INPUT: ceo ${sha}

Review prose.

- [High] Jitter bounds are untested
- [Low] Name the environment variable
`;

describe('submit --record', () => {
  test('a table record without a receipt is refused unless attested, and an attested bind names its attempt', () => {
    const out = start();
    const rec = write(out, 'ceo-table.md', TABLE);
    const before = fs.readFileSync(path.join(out, 'run.json'), 'utf8');
    const bare = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--record', rec, '--model', 'anthropic/claude-opus-5-5']);
    expect(bare.status).toBe(1);
    expect(bare.stderr).toMatch(/--attest.*\(RESULT_RECEIPT_MISSING\)$/m);
    const noAttempt = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--record', rec, '--model', 'anthropic/claude-opus-5-5', '--attest', 'subagent ran from the prompt file']);
    expect(noAttempt.status).toBe(3);
    expect(noAttempt.stderr).toMatch(/--attempt.*\(ATTEMPT_MISMATCH\)$/m);
    expect(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).toBe(before);
    const attempt = readRunJson(out).phases.ceo.native.attempt;
    const ok = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--record', rec, '--model', 'anthropic/claude-opus-5-5', '--attest', 'subagent ran from the prompt file', '--attempt', attempt]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(new RegExp(`^BOUND: ${attempt} phase=ceo voice=native .*findings=2 .*receipt=attested`, 'm'));
    const v = readRunJson(out).phases.ceo.native;
    expect(v).toMatchObject({ status: 'completed', receipt: 'attested', attest_reason: 'subagent ran from the prompt file', findings_source: 'table' });
    expect(fs.readFileSync(boundOf(out, 'ceo', 'native'), 'utf8')).toBe(TABLE);
    const rows = readJsonl(`${boundOf(out, 'ceo', 'native')}.findings.jsonl`);
    expect(rows.map(x => [x.severity, x.title, x.file ?? null, x.line ?? null])).toEqual([['High', 'Retry cap is unbounded on restart', 'lib/worker.ts', 10], ['Medium', 'Split persistence change into its own plan', null, null]]);
    expect(readRunJson(out).deviations.some((d: string) => /attested.*ceo native/.test(d))).toBe(true);
  });

  test('a record with the receipt binds a severity-tagged list without --attempt, and `No findings.` binds zero rows', () => {
    const out = start();
    const ok = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--record', write(out, 'l.md', list(snapshotOf(out))), '--model', 'anthropic/claude-opus-5-5']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^BOUND: \S+-a1 phase=ceo voice=native .*findings=2 .*receipt=verified/m);
    expect(readRunJson(out).phases.ceo.native).toMatchObject({ receipt: 'verified', findings_source: 'list' });
    const none = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--record', write(out, 'none.md', `INPUT: ceo ${snapshotOf(out)}\n\nRead it all.\n\nNo findings.\n`), '--model', 'openai/gpt-6.1-sol']);
    expect(none.status, none.stderr).toBe(0);
    expect(none.stdout).toMatch(/^BOUND: \S+-a2 phase=ceo voice=outside .*findings=0/m);
    expect(none.stdout).toMatch(/^PHASE_CLOSED: ceo .*coverage=both/m);
  });

  test('refusals write nothing: a wrong receipt (even attested), prose with no findings shape, two shapes, an unknown severity', () => {
    const out = start();
    const attempt = readRunJson(out).phases.ceo.native.attempt;
    const before = { run: fs.readFileSync(path.join(out, 'run.json'), 'utf8'), journal: readJsonl(path.join(out, 'attempts.jsonl')).length };
    const submit = (text: string, extra: string[] = []) => r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--record', write(out, `bad${++n}.md`, text), '--model', 'anthropic/claude-opus-5-5', ...extra]);
    const wrong = submit(`INPUT: ceo ${'0'.repeat(64)}\n\nNo findings.\n`, ['--attest', 'trust me', '--attempt', attempt]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/\(RESULT_RECEIPT_MISSING\)$/m);
    const prose = submit(`INPUT: ceo ${snapshotOf(out)}\n\nThe plan looks fine overall but I have concerns.\n`);
    expect(prose.status).toBe(1);
    expect(prose.stderr).toMatch(/table.*list.*No findings\..*\(RESULT_FINDINGS_MISSING\)$/m);
    expect(prose.stderr).toContain(`; fix: ${RESULT_CODES.RESULT_FINDINGS_MISSING.fix} (RESULT_FINDINGS_MISSING)`);
    const two = submit(`${list(snapshotOf(out))}\n${TABLE}`);
    expect(two.status).toBe(1);
    expect(two.stderr).toMatch(/more than one findings shape.*\(RESULT_FINDINGS_MISSING\)$/m);
    const spicy = submit(`INPUT: ceo ${snapshotOf(out)}\n\n| Severity | Title |\n|---|---|\n| Spicy | Too hot |\n`);
    expect(spicy.status).toBe(1);
    expect(spicy.stderr).toMatch(/row 1: severity "Spicy".*\(RESULT_FINDINGS_MISSING\)$/m);
    expect(fs.readFileSync(path.join(out, 'run.json'), 'utf8')).toBe(before.run);
    expect(readJsonl(path.join(out, 'attempts.jsonl')).length).toBe(before.journal);
  });

  test('the canonical --result path binds without --attempt when exactly one attempt is open', () => {
    const out = start();
    expect(r.review(path.join(out, 'ceo-native-prompt.md')).status).toBe(0);
    const ok = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(out, 'ceo', 'native'), '--model', 'anthropic/claude-opus-5-5']);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/^BOUND: \S+-a1 phase=ceo voice=native .*findings=3/m);
  });

  test('a phase that next has not opened is refused with the next command', () => {
    const out = start();
    const res = r.ap(['submit', '--out', out, '--phase', 'eng', '--voice', 'native', '--record', write(out, 'eng.md', 'No findings.\n'), '--model', 'anthropic/claude-opus-5-5']);
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(new RegExp(`run gstack-autoplan next --out ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*\\(PHASE_NOT_AWAITING\\)$`, 'm'));
  });

  test('--voice outside --unavailable closes the phase native_only; next never redispatches it and resume never resurrects it', () => {
    const out = start();
    const outsideAttempt = readRunJson(out).phases.ceo.outside.attempt;
    const un = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--unavailable', 'no codex on this host']);
    expect(un.status, un.stderr).toBe(0);
    expect(un.stdout).toMatch(/^OUTSIDE: ceo unavailable/m);
    const j = readJsonl(path.join(out, 'attempts.jsonl'));
    expect(j.find(e => e.event === 'outside_unavailable')).toMatchObject({ phase: 'ceo', attempt: outsideAttempt, detail: 'no codex on this host' });
    expect(readRunJson(out).phases.ceo.outside).toMatchObject({ status: 'unavailable', detail: 'no codex on this host' });
    const again = r.ap(['next', '--out', out]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toMatch(/voice=outside/);
    expect(again.stdout).toMatch(/^ATTEMPT: \S+ phase=ceo voice=native .*\(open\)$/m);
    const nativeAttempt = readRunJson(out).phases.ceo.native.attempt;
    const resumed = r.ap(['resume', '--out', out]);
    expect(resumed.stdout).toMatch(/execution_unknown=1 /);
    expect(resumed.stdout).toContain(`EXECUTION_UNKNOWN: ${nativeAttempt}\n`);
    expect(resumed.stdout).not.toContain(outsideAttempt);
    expect(readRunJson(out).phases.ceo.outside.status).toBe('unavailable');
    expect(r.review(path.join(out, 'ceo-native-prompt.md')).status).toBe(0);
    const close = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(out, 'ceo', 'native'), '--model', 'anthropic/claude-opus-5-5']);
    expect(close.stdout).toMatch(/^PHASE_CLOSED: ceo .*coverage=native_only/m);
  });

  test('--failed records a failed outside voice and closes the phase once native is bound', () => {
    const out = start();
    expect(r.review(path.join(out, 'ceo-native-prompt.md')).status).toBe(0);
    expect(r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'native', '--result', resultOf(out, 'ceo', 'native'), '--model', 'anthropic/claude-opus-5-5']).status).toBe(0);
    const failed = r.ap(['submit', '--out', out, '--phase', 'ceo', '--voice', 'outside', '--failed', 'runner exited 1']);
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.stdout).toMatch(/^PHASE_CLOSED: ceo .*coverage=native_only/m);
    expect(readRunJson(out).phases.ceo.outside).toMatchObject({ status: 'failed', detail: 'runner exited 1' });
  });
});
