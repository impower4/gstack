import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deriveNativeChecks, nativeEvidence, nativeTestRequirements, parseJUnit, type JUnitCase } from '../scripts/cso-native-evidence';
import { requiredChecks } from '../scripts/cso-runtime-promotion';

const ROOT = resolve(import.meta.dir, '..');
const STACKS = ['node', 'bun', 'python', 'rails', 'postgresql'] as const;
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Mirrors Bun 1.4.0 `bun test --reporter=junit` output: passing cases self-close, skips and failures carry a child element.
function report(cases: JUnitCase[]): string {
  const body = cases.map(item => {
    const open = `<testcase name="${escape(item.name)}" classname="suite" time="0.1" file="${item.file}" line="1" assertions="${item.assertions}"`;
    if (item.status === 'passed') return `      ${open} />`;
    const child = item.status === 'skipped' ? '<skipped />' : '<failure type="AssertionError" message="expected">AssertionError</failure>';
    return `      ${open}>\n        ${child}\n      </testcase>`;
  }).join('\n');
  const failures = cases.filter(item => item.status === 'failed').length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${cases.length}" failures="${failures}">\n  <testsuite name="suite">\n${body}\n  </testsuite>\n</testsuites>\n`;
}

function passing(stack: typeof STACKS[number]): JUnitCase[] {
  const seen = new Map<string, JUnitCase>();
  for (const refs of Object.values(nativeTestRequirements(stack))) for (const ref of refs) seen.set(`${ref.file}\0${ref.name}`, { ...ref, status: 'passed', assertions: 3 });
  return [...seen.values()];
}

function staged(stack: string, platform = 'linux/amd64') {
  return { schemaVersion: 1, state: 'staged', stack, platform, image: `ghcr.io/garrytan/gstack/cso-staging/${stack}-amd64@sha256:${'a'.repeat(64)}` };
}

describe('CSO native gate evidence', () => {
  test('native check keys are release gates of their stack, and private checks are exactly the remainder', () => {
    for (const stack of STACKS) {
      const native = Object.keys(nativeTestRequirements(stack));
      expect(native.every(key => requiredChecks(stack).includes(key))).toBe(true);
      const evidence = nativeEvidence(staged(stack), stack, 'linux/amd64', report(passing(stack))) as any;
      expect(Object.values(evidence.nativeChecks).every(value => value === true)).toBe(true);
      expect(Object.keys(evidence.privateChecks).sort()).toEqual(requiredChecks(stack).filter(key => !native.includes(key)));
      expect(Object.values(evidence.privateChecks).every(value => value === 'pending')).toBe(true);
      expect(evidence).toMatchObject({ state: 'native-gates-passed', qualified: false, stack });
      expect(evidence.nativeTestReport).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
    const postgres = nativeEvidence(staged('postgresql'), 'postgresql', 'linux/amd64', report(passing('postgresql'))) as any;
    expect(Object.keys(postgres.privateChecks).sort()).toEqual(['secretCanaryPassed', 'watchdogCleanupPassed']);
    const rails = nativeEvidence(staged('rails'), 'rails', 'linux/amd64', report(passing('rails'))) as any;
    expect(Object.keys(rails.privateChecks).sort()).toEqual(['accuracyGatesPassed', 'heldOutRepairPassed', 'secretCanaryPassed', 'watchdogCleanupPassed']);
  });

  test('a skipped, missing, failed, duplicated, or assertion-free named test leaves its checks false', () => {
    const named = nativeTestRequirements('node').positiveNegativeAssertionsPassed[0];
    const mutate = (change: (cases: JUnitCase[]) => JUnitCase[]) => deriveNativeChecks('node', parseJUnit(report(change(passing('node')))));
    const skipped = mutate(cases => cases.map(item => item.name === named.name ? { ...item, status: 'skipped' as const, assertions: 0 } : item));
    expect(skipped.positiveNegativeAssertionsPassed).toBe(false);
    expect(skipped.containmentPassed).toBe(false);
    expect(skipped.coldStartPassed).toBe(true);
    expect(mutate(cases => cases.filter(item => item.name !== named.name)).positiveNegativeAssertionsPassed).toBe(false);
    expect(mutate(cases => [...cases, cases.find(item => item.name === named.name)!]).positiveNegativeAssertionsPassed).toBe(false);
    expect(mutate(cases => cases.map(item => item.name === named.name ? { ...item, assertions: 0 } : item)).positiveNegativeAssertionsPassed).toBe(false);
    const unrelatedFailure = mutate(cases => [...cases, { file: 'test/other.test.ts', name: '(unnamed)', status: 'failed', assertions: 0 }]);
    expect(Object.values(unrelatedFailure).every(value => value === false)).toBe(true);
    expect(() => nativeEvidence(staged('node'), 'node', 'linux/amd64', report(passing('node').map(item => item.name === named.name ? { ...item, status: 'skipped', assertions: 0 } : item))))
      .toThrow('NATIVE_GATE_NOT_PASSED: containmentPassed, positiveNegativeAssertionsPassed');
  });

  test('a different file with the same test name does not satisfy a gate', () => {
    const cases = passing('bun').map(item => item.file === 'test/cso-stack-cold-integration.test.ts' ? { ...item, file: 'test/elsewhere.test.ts' } : item);
    const checks = deriveNativeChecks('bun', cases);
    expect(checks.coldStartPassed).toBe(false);
    expect(checks.acquisitionPublicOnlyPassed).toBe(false);
    expect(checks.positiveNegativeAssertionsPassed).toBe(true);
  });

  test('staged evidence must describe the same stack and platform', () => {
    expect(() => nativeEvidence(staged('bun'), 'node', 'linux/amd64', report(passing('node')))).toThrow('STAGED_EVIDENCE_MISMATCH');
    expect(() => nativeEvidence(staged('node', 'linux/arm64'), 'node', 'linux/amd64', report(passing('node')))).toThrow('STAGED_EVIDENCE_MISMATCH');
    expect(() => nativeEvidence({ ...staged('node'), state: 'qualified' }, 'node', 'linux/amd64', report(passing('node')))).toThrow('STAGED_EVIDENCE_MISMATCH');
    expect(() => parseJUnit('<testsuites/>')).toThrow('INVALID_JUNIT_REPORT');
    expect(() => parseJUnit('<?xml version="1.0"?>\n<testsuites name="bun test"></testsuites>')).toThrow('EMPTY_JUNIT_REPORT');
  });

  test.skipIf(process.platform==='win32')('the real Bun JUnit report of the Docker suites names every required test, and skipped suites prove nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cso-native-junit-')); temps.push(dir);
    const outfile = join(dir, 'native.xml');
    const env = { ...process.env };
    for (const key of ['GSTACK_CSO_DOCKER_TESTS', 'GSTACK_CSO_TEST_IMAGE', 'GSTACK_CSO_TEST_STACK']) delete env[key];
    const run = spawnSync(process.execPath, ['run', 'test:cso:docker', '--reporter=junit', `--reporter-outfile=${outfile}`], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
    expect(run.status, run.stderr).toBe(0);
    const cases = parseJUnit(readFileSync(outfile, 'utf8'));
    for (const stack of STACKS) {
      for (const refs of Object.values(nativeTestRequirements(stack))) for (const ref of refs) {
        expect(cases.filter(item => item.file === ref.file && item.name === ref.name).map(item => item.status)).toEqual(['skipped']);
      }
      expect(Object.values(deriveNativeChecks(stack, cases)).every(value => value === false)).toBe(true);
    }
  });
});
