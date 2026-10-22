/**
 * Runs the shard-equivalence fixture corpus through one checkout's free and
 * paid runners and prints their classifications as one JSON line.
 *
 *   bun test/fixtures/shard-equivalence/record.ts <checkout-root>
 *
 * expected.json was recorded by running this against the pre-engine base
 * commit (96764e80); test/shard-engine-equivalence.test.ts runs it against
 * the current checkout and requires identical classifications and lane exits.
 * Never imported by the test runner.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const FIXTURES = [
  'pass', 'fail', 'skip', 'wall-timeout', 'module-load-error', 'zero-executed', 'unhandled-between-tests',
] as const;
export const REAL_SHARD = 'test/strict-output.test.ts';
// Only the wall-timeout fixture should ever reach its wall; the others get
// generous headroom so a loaded CI host cannot turn a pass into a timeout.
const wallFor = (name: string) => (name === 'wall-timeout' ? 3_000 : 60_000);

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dir, '../../..'));
const fixtureDir = import.meta.dir;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-equivalence-'));
const free = await import(path.join(root, 'scripts/test-free-shards.ts'));
const paid = await import(path.join(root, 'scripts/test-paid-shards.ts'));
const freeExit = (status: string) => (status === 'passed' ? 0 : status === 'timed-out' ? 124 : 1);

try {
  const runFree = (file: string, index: number) => free.runFreeShard([file], index + 1, FIXTURES.length, {
    rootDir: root, quiet: true, log: () => {}, wallTimeoutMs: wallFor(FIXTURES[index]),
    logFilePath: path.join(scratch, `free-${index}.log`),
  });
  const runPaid = (file: string, index: number) => paid.runPaidShard([file], index + 1, FIXTURES.length, {
    rootDir: root, timeoutMs: wallFor(FIXTURES[index]), jobs: 2, logDir: scratch, log: () => {},
    env: { ...process.env, GSTACK_CLAUDE_CLI_VERSION: 'fixture', EVALS: '', EVALS_TIER: '', EVALS_ALL: '' },
  });
  const files = FIXTURES.map(name => path.join(fixtureDir, `${name}.fixture.ts`));
  const [freeOutcomes, paidOutcomes, real] = await Promise.all([
    Promise.all(files.map(runFree)),
    Promise.all(files.map(runPaid)),
    free.runFreeShard([REAL_SHARD], 1, 1, {
      rootDir: root, quiet: true, log: () => {}, logFilePath: path.join(scratch, 'real.log'),
    }),
  ]);
  const byName = <T>(values: T[]) => Object.fromEntries(FIXTURES.map((name, index) => [name, values[index]]));
  // Lane exit for a run of just that fixture, and for the whole corpus.
  const paidExit = (outcomes: unknown[], evalsAll: boolean) =>
    paid.summaryExitCode(paid.summarize(paid.applyHollowShardGuard(outcomes, { evalsAll, warn: () => {} })));
  const record = {
    free: {
      fixtures: byName(freeOutcomes.map((o: any) => ({ status: o.status, exitCode: o.exitCode, laneExit: freeExit(o.status) }))),
      laneExit: Math.max(...freeOutcomes.map((o: any) => freeExit(o.status))),
    },
    paid: {
      fixtures: byName(paidOutcomes.map((o: any) => ({
        status: o.status, exitCode: o.exitCode, executedTests: o.executedTests, skippedTests: o.skippedTests,
        laneExit: { selective: paidExit([o], false), evalsAll: paidExit([o], true) },
      }))),
      laneExit: { selective: paidExit(paidOutcomes, false), evalsAll: paidExit(paidOutcomes, true) },
    },
    realShard: { file: REAL_SHARD, status: real.status, ...real.summary },
  };
  console.log(`SHARD_EQUIVALENCE:${JSON.stringify(record)}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
