#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/** Derive native runtime gate evidence from the named Docker tests that actually executed and passed. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256 } from '../lib/cso/contracts';
import type { ImageBuildRow } from './cso-image-matrix';
import { requiredChecks } from './cso-runtime-promotion';

type Stack = ImageBuildRow['stack'];
export interface TestRef { file: string; name: string }
export interface JUnitCase extends TestRef { status: 'passed' | 'failed' | 'skipped'; assertions: number }

const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const DOCKER = 'test/cso-docker-integration.test.ts';
const CONTAINMENT: TestRef[] = [
  { file: DOCKER, name: 'hard fails when local daemon enforcement prerequisites are absent' },
  { file: DOCKER, name: 'rejects image-declared writable volumes before container creation' },
  { file: DOCKER, name: 'shares only loopback while denying egress, privileges, and daemon logs, and reads private source/policy mounts' },
  { file: DOCKER, name: 'machine-wide admission allows only two groups per endpoint' },
];
const STAGED: TestRef = { file: DOCKER, name: 'staged runtime executes its trusted verifier and checks every declared tool version' };
const NODE_LIFECYCLE: TestRef = {
  file: 'test/cso-node-lifecycle-integration.test.ts',
  name: 'finds, reproduces, bundles, replays, and closes against current source through the command dispatcher',
};
const COLD_JOURNEY: TestRef = {
  file: 'test/cso-stack-cold-integration.test.ts',
  name: 'acquires, prepares, boots, controls, and tests the requested staged stack with no target egress',
};

/** Each native check key names the tests whose execution proves it for one stack. */
export function nativeTestRequirements(stack: Stack): Record<string, TestRef[]> {
  if (stack === 'postgresql') return {
    containmentPassed: [...CONTAINMENT, STAGED],
    coldStartPassed: [STAGED],
    multiDatabasePassed: [STAGED],
    readinessPassed: [STAGED],
  };
  const journey = stack === 'node' ? NODE_LIFECYCLE : COLD_JOURNEY;
  const application = {
    containmentPassed: [...CONTAINMENT, STAGED],
    coldStartPassed: [journey],
    positiveNegativeAssertionsPassed: [STAGED],
    acquisitionPublicOnlyPassed: [journey],
    offlineLifecyclePassed: [journey],
  };
  return stack === 'rails'
    ? { ...application, railsSqlitePassed: [COLD_JOURNEY], railsPostgresqlPassed: [COLD_JOURNEY], nativeExtensionsPassed: [COLD_JOURNEY] }
    : application;
}

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]!;
  });
}

/** Parse the testcases of Bun's `--reporter=junit` output. */
export function parseJUnit(xml: string): JUnitCase[] {
  if (!/^<\?xml[^>]*\?>\s*<testsuites\b/.test(xml)) throw new Error('INVALID_JUNIT_REPORT');
  const cases: JUnitCase[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([A-Za-z_:][\w:.-]*)="([^"]*)"/g)].map(([, key, value]) => [key, decode(value)]));
    const body = match[2] ?? '';
    const status = /<(?:failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    const assertions = Number(attributes.assertions ?? '0');
    if (typeof attributes.name !== 'string' || typeof attributes.file !== 'string' || !Number.isInteger(assertions) || assertions < 0) {
      throw new Error('INVALID_JUNIT_TESTCASE');
    }
    cases.push({ file: attributes.file, name: attributes.name, status, assertions });
  }
  if (cases.length === 0) throw new Error('EMPTY_JUNIT_REPORT');
  return cases;
}

/** A check passes only when the whole report has no failure and every named test ran once, passed, and asserted. */
export function deriveNativeChecks(stack: Stack, cases: JUnitCase[]): Record<string, boolean> {
  const clean = cases.some(item => item.status === 'passed') && !cases.some(item => item.status === 'failed');
  const passed = (ref: TestRef) => {
    const matches = cases.filter(item => item.file === ref.file && item.name === ref.name);
    return matches.length === 1 && matches[0].status === 'passed' && matches[0].assertions > 0;
  };
  return Object.fromEntries(Object.entries(nativeTestRequirements(stack))
    .map(([key, refs]) => [key, clean && refs.every(passed)]));
}

/** Native evidence for one staged row; private checks are every required release gate the native job cannot prove. */
export function nativeEvidence(staged: unknown, stack: Stack, platform: string, report: string): Record<string, unknown> {
  const record = staged as Record<string, unknown>;
  if (!record || typeof record !== 'object' || record.state !== 'staged' || record.stack !== stack || record.platform !== platform) {
    throw new Error('STAGED_EVIDENCE_MISMATCH');
  }
  const required = requiredChecks(stack);
  const nativeChecks = deriveNativeChecks(stack, parseJUnit(report));
  const failed = Object.entries(nativeChecks).filter(([key, value]) => !value || !required.includes(key)).map(([key]) => key);
  if (failed.length) throw new Error(`NATIVE_GATE_NOT_PASSED: ${failed.sort().join(', ')}`);
  return {
    ...record,
    state: 'native-gates-passed',
    nativeChecks,
    nativeTestReport: `sha256:${sha256(report)}`,
    privateChecks: Object.fromEntries(required.filter(key => !(key in nativeChecks)).map(key => [key, 'pending'])),
    qualified: false,
    promotion: 'prohibited until authenticated private qualification evidence completes every release gate',
  };
}

function readFile(file: string): string {
  const stat = fs.lstatSync(path.resolve(file));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_REPORT_BYTES) throw new Error('UNSAFE_NATIVE_EVIDENCE_INPUT');
  return fs.readFileSync(path.resolve(file), 'utf8');
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const names = ['--stack', '--platform', '--junit', '--staged', '--output'];
    if (args.length !== names.length * 2 || names.some((name, index) => args[index * 2] !== name)) {
      throw new Error('Usage: cso-native-evidence.ts --stack STACK --platform PLATFORM --junit REPORT.xml --staged staged-image.json --output EVIDENCE.json');
    }
    const [stack, platform, junit, staged, output] = names.map((_, index) => args[index * 2 + 1]);
    if (!['node', 'bun', 'python', 'rails', 'postgresql'].includes(stack)) throw new Error('INVALID_STACK');
    const evidence = nativeEvidence(JSON.parse(readFile(staged)), stack as Stack, platform, readFile(junit));
    fs.writeFileSync(path.resolve(output), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'NATIVE_EVIDENCE_FAILED') + '\n');
    process.exitCode = 1;
  }
}
