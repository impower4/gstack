import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import * as dockerModule from '../lib/cso/docker';
import { DockerGroup } from '../lib/cso/docker';
import { runProcess } from '../lib/cso/process';
import { createDockerScannerRunner } from '../lib/cso/scanner-executor';
import { parseScannerOutput, scannerPlans } from '../lib/cso/scanners';
import { redactFindingSpans, redactJsonFindingSpans } from '../lib/redact-engine';

// #3185: a scanner's JSON report must stay parseable after redaction. A bare
// 10+ digit number (Semgrep's time.max_memory_bytes, an epoch) used to become an
// unquoted marker, JSON.parse failed and /cso reported INVALID_OUTPUT.

const roots: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'cso-json-redaction-')));
  roots.push(dir);
  return dir;
};
const PHONE = '<REDACTED-pii.phone.e164>';
const json = (input: string) => {
  const result = redactJsonFindingSpans(input);
  expect(result).not.toBeNull();
  // The released text is a fixpoint: a second scan finds nothing (the views check in lib/cso/process.ts).
  expect(redactFindingSpans(result!.body)).toBe(result!.body);
  return result!.body;
};
const semgrepPlan = () => scannerPlans({ snapshotRoot: '/source', offline: true, selected: ['semgrep'], semgrepRules: '/policy/catalog/semgrep.yml' })[0]!;
const SEMGREP_REPORT = {
  results: [{ check_id: 'test-rule', path: '/source/app.js', start: { line: 1, col: 1 }, extra: { message: 'Candidate code defect', severity: 'ERROR' } }],
  errors: [], paths: { scanned: ['/source/app.js'] }, time: { max_memory_bytes: 1145427776 },
};

describe('redactJsonFindingSpans', () => {
  test('a bare number becomes a quoted marker and the document parses', () => {
    expect(JSON.parse(json('{"a":4155551234}'))).toEqual({ a: PHONE });
    expect(JSON.parse(json('{"time":{"max_memory_bytes":1145427776}}'))).toEqual({ time: { max_memory_bytes: PHONE } });
  });

  test('the whole number token is replaced: negative, exponent, every finding id', () => {
    expect(JSON.parse(json('{"a":-4155551234}'))).toEqual({ a: PHONE });
    expect(JSON.parse(json('{"x":1e-4155551234}'))).toEqual({ x: PHONE });
    expect(JSON.parse(json('{"when": 1757012345678}'))).toEqual({ when: '<REDACTED-pii.cc+pii.phone.e164>' });
  });

  test('arrays, whitespace, several top-level values and NDJSON', () => {
    expect(JSON.parse(json('[4155551234,4155551235]'))).toEqual([PHONE, PHONE]);
    expect(JSON.parse(json('{ "a" :\n  4155551234 }'))).toEqual({ a: PHONE });
    expect(json('{"k":1}\n{"k":4155551234}\n{"k":4155551235}\n').trim().split('\n').map(line => JSON.parse(line)))
      .toEqual([{ k: 1 }, { k: PHONE }, { k: PHONE }]);
    expect(json('{"k":4155551234}{"k":true}')).toBe(`{"k":"${PHONE}"}{"k":true}`);
  });

  test('spans inside strings keep the in-string marker, around punctuation and escaped quotes', () => {
    expect(JSON.parse(json('{"t":"call 415-555-1234, ok"}'))).toEqual({ t: `call ${PHONE}, ok` });
    expect(JSON.parse(json('{"t":"x\\"4155551234\\"y"}'))).toEqual({ t: `x"${PHONE}"y` });
    expect(JSON.parse(json('{"t":"4155551234\\n"}'))).toEqual({ t: `${PHONE}\n` });
  });

  test('a span across several tokens withholds; marker-only findings withhold', () => {
    expect(redactFindingSpans('[4111 1111 1111 1111]')).toBe('[<REDACTED-pii.cc+pii.phone.e164>]');
    expect(redactJsonFindingSpans('[4111 1111 1111 1111]')).toBeNull();
    expect(redactJsonFindingSpans(['{"k":"-----BEGIN RSA ', 'PRIVATE KEY-----\\nMIIE"}'].join(''))).toBeNull();
  });

  test('a stream that is not JSON keeps the plain splice', () => {
    expect(json('plain 4155551234 text')).toBe(redactFindingSpans('plain 4155551234 text')!);
    expect(redactFindingSpans('{"a":4155551234}')).toBe(`{"a":${PHONE}}`);
  });
});

describe.skipIf(process.platform === 'win32')('scan stdout through the process boundary', () => {
  test('a JSON-declared stdout parses after redaction; stderr and undeclared streams stay plain', async () => {
    const dir = tmp();
    const script = `printf '{"time":{"max_memory_bytes":11454'; sleep .05; printf 'peak 4155551234 bytes' >&2; sleep .05; printf '27776}}'`;
    const declared = await runProcess('/bin/sh', ['-c', script], { cwd: dir, env: { PATH: '/usr/bin:/bin' }, redaction: 'splice', stdoutFormat: 'json' });
    expect(JSON.parse(declared.stdout)).toEqual({ time: { max_memory_bytes: PHONE } });
    expect(declared.stderr).toBe(`peak ${PHONE} bytes`);
    const plain = await runProcess('/bin/sh', ['-c', `printf '{"a":4155551234}'`], { cwd: dir, env: { PATH: '/usr/bin:/bin' }, redaction: 'splice' });
    expect(plain.stdout).toBe(`{"a":${PHONE}}`);
  });

  test('a secret split across channels is still withheld with a JSON-declared stdout', async () => {
    const dir = tmp();
    const r = await runProcess('/bin/sh', ['-c', "printf '{\"k\":\"ghp_abcdefghijklmnop'; printf 'qrstuvwxyz1234567890\"}' >&2"],
      { cwd: dir, env: { PATH: '/usr/bin:/bin' }, redaction: 'splice', stdoutFormat: 'json' });
    expect(r.stdout + r.stderr).not.toContain('abcdefghijklmnop');
    expect(r.stdout).toBe('[sensitive process output redacted]');
  });
});

describe.skipIf(process.platform === 'win32')('Semgrep through the real executor capture path', () => {
  test('version then scan with stderr interleaved: the spliced report is complete', async () => {
    const dir = tmp();
    const report = JSON.stringify(SEMGREP_REPORT), cut = report.indexOf('1145427776') + 4;
    fs.writeFileSync(join(dir, 'part1'), report.slice(0, cut));
    fs.writeFileSync(join(dir, 'part2'), report.slice(cut));
    const docker = join(dir, 'docker');
    fs.writeFileSync(docker, [
      '#!/bin/sh',
      'for last; do :; done',
      `if [ "$last" = --version ]; then printf 'semgrep 1.179.0 (max 4155551234)\\n'; exit 0; fi`,
      `cat '${join(dir, 'part1')}'; sleep .05; printf 'Scanning 1 file with 4155551234 bytes\\n' >&2; sleep .05; cat '${join(dir, 'part2')}'`,
    ].join('\n') + '\n', { mode: 0o755 });
    const endpoint = { uri: 'unix:///run/fake.sock', socket: '/run/fake.sock', executable: docker, device: 0, inode: 0 };
    const spies = [
      spyOn(dockerModule, 'dockerEndpoint').mockResolvedValue(endpoint),
      spyOn(DockerGroup, 'create').mockImplementation(async (_e, runId, groupDir, deadline) => {
        const group = new (DockerGroup as any)(endpoint, runId, groupDir, deadline, {}) as DockerGroup;
        spyOn(group, 'createContainer').mockResolvedValue('c'.repeat(64));
        spyOn(group, 'start').mockResolvedValue(undefined);
        spyOn(group, 'cleanup').mockResolvedValue(undefined);
        return group;
      }),
    ];
    for (const spy of spies) restores.push(() => spy.mockRestore());
    const plan = semgrepPlan();
    const runner = await createDockerScannerRunner({
      input: { id: 'semgrep', runDir: dir, watchdogPath: '/trusted/test-watchdog' } as any,
      plan, profile: { image: `ghcr.io/garrytan/gstack/cso-scanners/semgrep-amd64@sha256:${'a'.repeat(64)}`, executable: '/opt/cso/bin/scanner' } as any,
      deadline: Date.now() + 60_000,
    });
    const version = await runner.version();
    const scan = await runner.scan();
    await runner.cleanup();
    expect(version.stdout).toBe(`semgrep 1.179.0 (max ${PHONE})\n`);
    expect(scan.stderr).toBe(`Scanning 1 file with ${PHONE} bytes\n`);
    expect(JSON.parse(scan.stdout).time).toEqual({ max_memory_bytes: PHONE });
    const outcome = parseScannerOutput(plan, { ...scan, version: version.stdout });
    expect(outcome.gaps).toEqual([]);
    expect(outcome.status).toBe('complete');
    expect(outcome.candidates).toHaveLength(1);
  });
});
