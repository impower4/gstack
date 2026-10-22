/**
 * Argument vectors for the per-lane CLI parity check. results.json holds the
 * parse results the pre-engine runners (base 96764e80) produced for them.
 */
export const FREE_CASES: string[][] = [
  [],
  ['--dry-run', '--list', '--verbose'],
  ['--windows-only', '--list'],
  ['--record-durations'],
  ['--quick'],
  ['--shards', '4', '--shard', '2'],
  ['--wall-timeout', '600'],
  ['--ci-plan', 'plan.json', '--shards', '20'],
  ['--ci-run', 'plan.json', '--shard', '1', '--result', 'result.json'],
  ['--ci-verify', 'plan.json', '--results', 'results'],
  ['--bogus'],
  ['--list', '--bogus'],
  ['--shards'],
  ['--shard'],
  ['--wall-timeout', '0'],
  ['--wall-timeout'],
  ['--ci-plan'],
  ['--ci-plan', '--list'],
  ['--ci-plan', 'a.json', '--ci-run', 'b.json'],
  ['--ci-plan', 'a.json', '--quick'],
  ['--ci-run', 'plan.json'],
  ['--ci-verify', 'plan.json'],
  ['--quick', '--shard', '1'],
  ['--quick', '--windows-only'],
  ['--attribute-home'],
  ['--ci-plan', 'a.json', '--attribute-home'],
];

export const PAID_CASES: Array<{ argv: string[]; env?: Record<string, string> }> = [
  { argv: [] },
  { argv: ['--list', '--tier', 'periodic', '--profile', 'full'] },
  { argv: ['--tier', 'gate', '--profile', 'pr', '--list'] },
  { argv: ['--timeout', '600', '--jobs', '2', '--files-per-shard', '3'] },
  { argv: ['--emit-plan', 'manifest.json', '--slices', '4', '--skip-judges'] },
  { argv: ['--plan', 'manifest.json', '--slice', '2'] },
  { argv: ['--report', 'reports', '--write-durations'] },
  { argv: [], env: { EVALS_TIER: 'periodic', EVALS_JOBS: '3', EVALS_CONCURRENCY: '5', EVALS_SHARD_TIMEOUT_MS: '1000', EVALS_PROFILE: 'full' } },
  { argv: ['--bogus'] },
  { argv: ['--list', '--bogus'] },
  { argv: ['--tier', 'e2e'] },
  { argv: ['--tier'] },
  { argv: ['--profile'] },
  { argv: ['--profile', 'fast'] },
  { argv: ['--timeout', '0'] },
  { argv: ['--jobs'] },
  { argv: ['--emit-plan'] },
  { argv: ['--plan'] },
  { argv: ['--report'] },
  { argv: ['--write-durations'] },
  { argv: ['--skip-judges'] },
  { argv: ['--profile', 'pr', '--tier', 'periodic'] },
  { argv: ['--profile', 'pr', '--files-per-shard', '2'] },
  { argv: [], env: { EVALS_TIER: 'e2e' } },
];

export type ParseResult = { ok: unknown } | { error: string };

export function capture(parse: () => unknown): ParseResult {
  try { return { ok: parse() }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
