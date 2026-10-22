/**
 * Per-lane CLI parity across the shard-engine refactor: each runner accepts
 * the same flags with the same defaults and validation messages, and emits
 * the same `Unknown argument:` error, as the pre-engine runners recorded in
 * test/fixtures/shard-cli-parity/results.json (base 96764e80).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCliOptions as parseFree } from '../scripts/test-free-shards';
import { parseCliOptions as parsePaid } from '../scripts/test-paid-shards';
import { FREE_CASES, PAID_CASES, capture } from './fixtures/shard-cli-parity/cases';

const ROOT = path.resolve(import.meta.dir, '..');
const recorded = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/shard-cli-parity/results.json'), 'utf8'));

describe('shard runner CLI parity with the pre-engine runners', () => {
  test('free lane: same flags, defaults and validation errors', () => {
    expect(FREE_CASES.map(argv => ({ argv, result: capture(() => parseFree(argv)) }))).toEqual(recorded.free);
  });

  test('paid lane: same flags, env-derived defaults and validation errors', () => {
    expect(PAID_CASES.map(c => ({ ...c, result: capture(() => parsePaid(c.argv, c.env ?? {})) }))).toEqual(recorded.paid);
  });

  test.each(['free', 'paid'] as const)('%s CLI rejects an unknown flag with the same message and exit code', lane => {
    const run = spawnSync(process.execPath, [path.join(ROOT, `scripts/test-${lane}-shards.ts`), '--bogus'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    });
    expect({ status: run.status, stderr: run.stderr.trim() }).toEqual(recorded.unknownArgumentCli[lane]);
  });
});
