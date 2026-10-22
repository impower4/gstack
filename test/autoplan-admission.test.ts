/**
 * Admission at `gstack-autoplan`'s mutating verbs (plan Lane A amendments,
 * as corrected: the verdict is required only under GSTACK_CAPY=1). On a Capy
 * host (GSTACK_CAPY=1) `next`, `submit`, `answer`, `revise` and `export`
 * refuse unless the install verdict at GSTACK_INSTALL_VERDICT says `gstack:
 * ok` for this checkout and HEAD; any unattended session also refuses when
 * the PATH Bun is below gstack's supported minimum. `status` and `resume` stay
 * available. GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 overrides and is recorded as
 * a run deviation. Interactive sessions are never gated here.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RESULT_CODES } from '../lib/result-codes';
import { ROOT } from './helpers/autoplan-run-fixture';
import { HEAD, capyRunner, readRunJson, writePlan } from './helpers/autoplan-capy';

const runners: Array<{ cleanup(): void }> = [];
afterAll(() => runners.forEach(r => r.cleanup()));
const make = (o: Parameters<typeof capyRunner>[0] = {}) => { const r = capyRunner(o); runners.push(r); return r; };
const first = (r: ReturnType<typeof capyRunner>, name: string, extra: Record<string, string> = {}) => {
  const dir = path.join(r.host.base, name);
  const out = path.join(dir, 'run');
  return { out, res: r.ap(['next', '--out', out, '--plan', writePlan(dir), '--no-ui'], extra) };
};

describe('admission', () => {
  test('GSTACK_CAPY=1 without a verdict refuses before writing anything', () => {
    const r = make({ verdict: null });
    const { out, res } = first(r, 'none');
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/no install verdict at .*\(INSTALL_UNVERIFIED\)$/m);
    expect(res.stderr).toContain(`; fix: ${RESULT_CODES.INSTALL_UNVERIFIED.fix} (INSTALL_UNVERIFIED)`);
    expect(res.stdout).toContain('GSTACK_RESULT: skill=autoplan status=refused');
    expect(fs.existsSync(path.join(out, 'run.json'))).toBe(false);
  });

  test('a failing verdict, or one for another HEAD or checkout, refuses with the trailer', () => {
    const r = make();
    r.writeVerdict({ trailer: 'gstack: fail runtime' });
    expect(first(r, 'fail').res.stderr).toMatch(/gstack: fail runtime.*\(INSTALL_UNVERIFIED\)$/m);
    r.writeVerdict({ head: '0'.repeat(40) });
    expect(first(r, 'head').res.stderr).toMatch(/another HEAD.*\(INSTALL_UNVERIFIED\)$/m);
    r.writeVerdict({ checkout: '/elsewhere/gstack' });
    expect(first(r, 'checkout').res.stderr).toMatch(/is for checkout \/elsewhere\/gstack.*\(INSTALL_UNVERIFIED\)$/m);
  });

  test('an ok verdict admits; status and resume need none; every mutating verb is gated', () => {
    const r = make();
    const { out, res } = first(r, 'ok');
    expect(res.status, res.stderr).toBe(0);
    fs.rmSync(r.verdict);
    expect(r.ap(['status', '--out', out]).status).toBe(0);
    expect(r.ap(['resume', '--out', out]).status).toBe(0);
    for (const args of [['next'], ['submit', '--phase', 'ceo', '--voice', 'outside', '--unavailable', 'x'], ['answer', '--gate-rev', '1', '--reply', 'all'], ['revise', '--plan', path.join(r.host.base, 'ok', 'plan.md')], ['export']]) {
      const res2 = r.ap([args[0]!, '--out', out, ...args.slice(1)]);
      expect(res2.status, args[0]).toBe(3);
      expect(res2.stderr, args[0]).toMatch(/\(INSTALL_UNVERIFIED\)$/m);
    }
  });

  test.skipIf(process.platform === 'win32')('an unattended session with the PATH Bun below the supported minimum refuses even with an ok verdict (the Capy host\'s bash bun stub cannot shadow bun.exe on Windows)', () => {
    const r = make({ launched: false });
    const { res } = first(r, 'oldbun');
    expect(res.status).toBe(3);
    expect(res.stderr).toMatch(/bun 1\.3\.14.*\(RUNTIME_BELOW_MINIMUM\)$/m);
  });

  test('GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1 overrides and is recorded as a run deviation', () => {
    const r = make({ verdict: null, launched: false });
    const { out, res } = first(r, 'override', { GSTACK_ALLOW_UNSUPPORTED_RUNTIME: '1' });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^ADMISSION: override GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1/m);
    expect(readRunJson(out).deviations.some((d: string) => d.startsWith('GSTACK_ALLOW_UNSUPPORTED_RUNTIME=1'))).toBe(true);
  });

  test('an interactive session is not gated', () => {
    const r = make({ verdict: null, launched: false });
    const { res } = first(r, 'interactive', { GSTACK_SESSION_KIND: 'interactive', GSTACK_CAPY: '' });
    expect(res.status, res.stderr).toBe(0);
  });
});
