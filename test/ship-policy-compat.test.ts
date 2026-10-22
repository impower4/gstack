/**
 * Field list 2, W1 round-2 obligation (ceo/outside High, dx/native Medium):
 * unknown ship-policy keys stay fail-closed, new keys (gate_command,
 * full_e2e) need min_gstack_version before they take a non-default value, an
 * old gstack refuses a policy that names a newer minimum, and validate prints
 * each key's introducing version. Includes an old client and a misspelled
 * gate-reuse restriction end to end through the real binaries.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { EXIT } from '../lib/headless-artifacts';
import { DEFAULT_POLICY, POLICY_KEY_INTRODUCED, SHIP_QUEUE_KEYS_VERSION, validatePolicy } from '../lib/ship-policy';
import { cmpVersion, parseVersion } from '../lib/version-source';
import { BASE_POLICY, cleanup, makeFixtureRepo, restamp, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const repos: FixtureRepo[] = [];
const fixture = (policy: Record<string, unknown>) => { const r = makeFixtureRepo({ policy }); repos.push(r); return r; };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const newestKeyVersion = Object.values(POLICY_KEY_INTRODUCED).reduce((a, b) => (cmpVersion(parseVersion(b)!, parseVersion(a)!) > 0 ? b : a));
const codes = (raw: unknown, gstackVersion = '1.91.200.0') => validatePolicy(raw, { gstackVersion }).map(e => `${e.code}@${e.path}`);

describe('policy compatibility floor', () => {
  test('defaults stay valid; new keys at their defaults need nothing', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual([]);
    expect(codes({ gate_command: null, full_e2e: false })).toEqual([]);
  });

  test('gate_command or full_e2e set without min_gstack_version is POLICY_INVALID naming the introducing version', () => {
    const errs = validatePolicy({ gate_command: 'bun run ci:gate', full_e2e: true }, { gstackVersion: '1.91.200.0' });
    expect(errs.map(e => e.path)).toEqual(['gate_command', 'full_e2e']);
    expect(errs[0]!.message).toBe(`introduced in gstack ${SHIP_QUEUE_KEYS_VERSION}; set min_gstack_version to ${SHIP_QUEUE_KEYS_VERSION} or later so an older gstack refuses this policy by name`);
    expect(codes({ gate_command: 'bun run ci:gate', full_e2e: true, min_gstack_version: SHIP_QUEUE_KEYS_VERSION })).toEqual([]);
    expect(codes({ gate_command: 'bun run ci:gate', min_gstack_version: '1.91.98.0' })).toEqual(['POLICY_INVALID@gate_command', 'POLICY_INVALID@min_gstack_version']);
  });

  test('an old client: a minimum above this gstack is POLICY_GSTACK_TOO_OLD; a key from a newer gstack is an unknown key, never ignored', () => {
    expect(codes({ gate_command: 'x', min_gstack_version: SHIP_QUEUE_KEYS_VERSION }, '1.91.106.0')).toEqual(['POLICY_GSTACK_TOO_OLD@min_gstack_version']);
    const future = validatePolicy({ gate_reuse_requires: ['e2e'] }, { gstackVersion: '1.91.200.0' });
    expect(future.map(e => `${e.code}@${e.path}`)).toEqual(['POLICY_INVALID@gate_reuse_requires']);
    expect(future[0]!.message).toContain(`this gstack reads keys introduced up to ${newestKeyVersion}`);
    expect(codes({ min_gstack_version: 'soon' })).toEqual(['POLICY_INVALID@min_gstack_version']);
    expect(codes({ full_e2e: 'yes', min_gstack_version: SHIP_QUEUE_KEYS_VERSION })).toEqual(['POLICY_INVALID@full_e2e']);
  });

  test('every key has an introducing version; keys up to the floor match the releases that added them', () => {
    expect(Object.keys(POLICY_KEY_INTRODUCED).sort()).toEqual(Object.keys(DEFAULT_POLICY).sort());
    expect(POLICY_KEY_INTRODUCED.stamp_sensitive_gates).toBe('1.91.73.0');
    expect(POLICY_KEY_INTRODUCED.stamp_files).toBe('1.91.98.0');
  });
});

describe('through the binaries', () => {
  test('validate prints each set key with its introducing version and the minimum reader', () => {
    const repo = fixture({ ...BASE_POLICY, gate_command: 'bun run test', full_e2e: true, min_gstack_version: SHIP_QUEUE_KEYS_VERSION });
    const r = runBin(repo, 'gstack-ship-policy', ['validate']);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('KEY: bump introduced=1.91.73.0\n');
    expect(r.out).toContain(`KEY: gate_command introduced=${SHIP_QUEUE_KEYS_VERSION}\n`);
    expect(r.out).toContain(`MIN_READER: gstack ${SHIP_QUEUE_KEYS_VERSION} `);
    expect(JSON.parse(runBin(repo, 'gstack-ship-policy', ['validate', '--json']).out).min_reader).toBe(SHIP_QUEUE_KEYS_VERSION);
    expect(runBin(repo, 'gstack-ship-policy', ['show-effective', '--base', 'main']).out).toMatch(/^ship: shared merge queue: .*gstack-ship-queue ready --pr <n>.*\(docs\/ship-policy\.md#run-a-shared-merge-queue\); gate command: `bun run test`$/m);
    const explain = runBin(repo, 'gstack-ship-policy', ['init', '--explain']);
    expect(explain.out).toMatch(new RegExp(`^full_e2e: .* default: false introduced: ${SHIP_QUEUE_KEYS_VERSION.replace(/\./g, '\\.')}$`, 'm'));
  }, 60_000);

  test('a policy naming a newer gstack is refused by validate and by gstack-restamp, nothing written', () => {
    const repo = fixture({ ...BASE_POLICY, min_gstack_version: '99.0.0.0' });
    const v = runBin(repo, 'gstack-ship-policy', ['validate']);
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toMatch(/this policy needs gstack 99\.0\.0\.0 or later; this gstack is .*\(POLICY_GSTACK_TOO_OLD\)/);
    const head = repo.git('rev-parse', 'HEAD');
    const r = restamp(repo, ['--next', '--pr', '1']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toContain('(POLICY_GSTACK_TOO_OLD)');
    expect(repo.git('rev-parse', 'HEAD')).toBe(head);
    expect(repo.git('status', '--porcelain')).toBe('');
  }, 60_000);

  test('a misspelled gate-reuse restriction fails closed: the tree receipt refuses instead of judging reuse without it', () => {
    const policy: Record<string, unknown> = { ...BASE_POLICY };
    delete policy.stamp_sensitive_gates;
    policy.stamp_sensitive_gate = ['digest'];
    const repo = fixture(policy);
    const r = runBin(repo, 'gstack-tree-receipt', ['--gated', 'HEAD', '--base', 'main']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/unknown key .* at stamp_sensitive_gate\); fix: .*\(POLICY_INVALID\)/);
    expect(r.out).not.toContain('gate-reuse: eligible');
  }, 60_000);
});
