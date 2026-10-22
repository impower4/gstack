import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SHARD_TIMEOUT_MS } from '../scripts/test-paid-shards';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';

const casePath = path.join(import.meta.dir, 'skill-e2e-office-hours-section-loading.test.ts');

// Evaluate the real case registrations with inert test/describe functions.
// Imports are removed, and the captured paid callbacks are never invoked.
function registrations(file = casePath): Array<{ tier: string; options: unknown }> {
  const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(fs.readFileSync(file, 'utf8'))
    .replace(/^import\b[^;]*;\s*$/gm, '');
  const found: Array<{ tier: string; options: unknown }> = [];
  new Function('test', 'describeE2ETier', 'CAPTURE_LONG_MS', source)(
    (_name: string, _callback: unknown, options: unknown) => found.at(-1)!.options = options,
    (tier: string) => (_name: string, register: () => void) => { found.push({ tier, options: undefined }); register(); },
    CAPTURE_LONG_MS,
  );
  return found;
}

test('the full office-hours workflow is one marathon-tier registration', () => {
  expect(registrations()).toEqual([{ tier: 'marathon', options: { timeout: 1_260_000, retry: 0 } }]);
});

test('the design-draft checkpoint is one periodic case inside the ordinary long capture budget', () => {
  const draft = path.join(import.meta.dir, 'skill-e2e-office-hours-design-draft.test.ts');
  expect(registrations(draft)).toEqual([{ tier: 'periodic', options: CAPTURE_LONG_MS }]);
  const source = fs.readFileSync(draft, 'utf8');
  expect(source).toContain('timeout: LONG_SECTION_CAPTURE_MS');
  expect(source).toContain('stop after the Write that saves the complete design');
  expect(source).toContain('Do not run the spec review, approval, relationship closing or handoff');
});

test('office-hours has one bounded attempt even under the paid runner CLI retry default', () => {
  const options = registrations()[0]!.options as { timeout: number; retry: number };
  expect(options).toEqual({ timeout: 1_260_000, retry: 0 });
  expect(options.timeout + 120_000).toBeLessThanOrEqual(DEFAULT_SHARD_TIMEOUT_MS);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-office-hours-retry-'));
  try {
    const fake = path.join(dir, 'retry.test.ts');
    fs.writeFileSync(fake, `import { afterAll, expect, test } from 'bun:test';
let defaults = 0, officeHours = 0, two = 0;
test('default retry', () => { defaults++; expect(defaults).toBe(2); });
test('office-hours retry', () => {
  officeHours++; throw new Error('intentional single-attempt failure');
}, ${JSON.stringify(options)});
test('existing two retries', () => { two++; expect(two).toBe(3); }, { retry: 2 });
afterAll(() => console.log('ATTEMPTS=' + JSON.stringify({ defaults, officeHours, two })));
`);
    const child = Bun.spawnSync([process.execPath, 'test', '--retry', '1', fake], {
      cwd: dir, stdout: 'pipe', stderr: 'pipe', timeout: 5_000,
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode).toBe(1); // the deliberate single-attempt failure stays failed
    const attempts = output.match(/ATTEMPTS=(\{[^\n]+\})/);
    expect(attempts, output).not.toBeNull();
    expect(JSON.parse(attempts![1])).toEqual({ defaults: 2, officeHours: 1, two: 3 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
