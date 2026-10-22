import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { CAPTURE_MS, CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { runSkillTest } from './helpers/session-runner';
import {
  ROOT, browseBin, runId, evalsEnabled,
  describeIfSelected, testConcurrentIfSelected,
  copyDirSync, setupBrowseShims, logCost, recordE2E,
  createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-deploy');

// --- Land-and-Deploy E2E ---

describeIfSelected('Land-and-Deploy skill E2E', ['land-and-deploy-workflow'], () => {
  let landDir: string;

  beforeAll(() => {
    landDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-land-deploy-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: landDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(landDir, 'app.ts'), 'export function hello() { return "world"; }\n');
    fs.writeFileSync(path.join(landDir, 'fly.toml'), 'app = "test-app"\n\n[http_service]\n  internal_port = 3000\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    run('git', ['checkout', '-b', 'feat/add-deploy']);
    fs.writeFileSync(path.join(landDir, 'app.ts'), 'export function hello() { return "deployed"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: update hello']);

    copyDirSync(path.join(ROOT, 'land-and-deploy'), path.join(landDir, 'land-and-deploy'));
  });

  afterAll(() => {
    try { fs.rmSync(landDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('land-and-deploy-workflow', async () => {
    const result = await runSkillTest({
      prompt: `Read land-and-deploy/SKILL.md for the /land-and-deploy skill instructions.
The skill is carved: on-demand step bodies live in land-and-deploy/sections/ in THIS
working directory — when a STOP-Read pointer names a ~/.claude/skills/gstack/... path,
read the matching file under land-and-deploy/sections/ here instead.

You are on branch feat/add-deploy with changes against main.

This run is non-interactive and the repo has no remote, so there is no PR and the gh
and fly CLIs are unavailable. Run the parts of the workflow that work without them,
mark the PR, merge and deploy results as simulated, and save the report you would
show under .gstack/deploy-reports/.`,
      workingDirectory: landDir,
      maxTurns: 20,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: CAPTURE_MS,
      testName: 'land-and-deploy-workflow',
      runId,
    });

    logCost('/land-and-deploy', result);
    recordE2E(evalCollector, '/land-and-deploy workflow', 'Land-and-Deploy skill E2E', result);
    expect(result.exitReason).toBe('success');

    // The prompt names neither the platform nor the app: the skill detects them from fly.toml.
    const reportDir = path.join(landDir, '.gstack', 'deploy-reports');
    expect(fs.existsSync(reportDir)).toBe(true);
    const claudeMd = path.join(landDir, 'CLAUDE.md');
    const artifacts = [
      ...fs.readdirSync(reportDir).filter(f => f.endsWith('.md')).map(f => fs.readFileSync(path.join(reportDir, f), 'utf-8')),
      fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf-8') : '',
    ].join('\n');
    expect(artifacts, 'deploy artifacts name the detected platform').toMatch(/fly/i);
    expect(artifacts, 'deploy artifacts name the detected app').toContain('test-app');
  }, CAPTURE_LONG_MS);
});

// --- Land-and-Deploy First-Run E2E ---

describeIfSelected('Land-and-Deploy first-run E2E', ['land-and-deploy-first-run'], () => {
  let firstRunDir: string;

  beforeAll(() => {
    firstRunDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-land-first-run-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: firstRunDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(firstRunDir, 'app.ts'), 'export function hello() { return "world"; }\n');
    fs.writeFileSync(path.join(firstRunDir, 'fly.toml'), 'app = "first-run-app"\n\n[http_service]\n  internal_port = 3000\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    run('git', ['checkout', '-b', 'feat/first-deploy']);
    fs.writeFileSync(path.join(firstRunDir, 'app.ts'), 'export function hello() { return "first deploy"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'feat: first deploy']);

    copyDirSync(path.join(ROOT, 'land-and-deploy'), path.join(firstRunDir, 'land-and-deploy'));
  });

  afterAll(() => {
    try { fs.rmSync(firstRunDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('land-and-deploy-first-run', async () => {
    const result = await runSkillTest({
      prompt: `Read land-and-deploy/SKILL.md for the /land-and-deploy skill instructions.
The Step 1.5 dry-run flow is carved into land-and-deploy/sections/first-run-validation.md
in THIS working directory — read it from there (the STOP-Read pointer's
~/.claude/skills/gstack/... path does not exist here).

You are on branch feat/first-deploy. This is the FIRST TIME running /land-and-deploy
for this project — there is NO land-deploy-confirmed file.

This run is non-interactive and the repo has no remote, so there is no PR and the gh
and fly CLIs are unavailable; treat their command checks as passing. Run the first-run
dry-run validation and save its report under .gstack/deploy-reports/.`,
      workingDirectory: firstRunDir,
      maxTurns: 20,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: CAPTURE_MS,
      testName: 'land-and-deploy-first-run',
      runId,
    });

    logCost('/land-and-deploy first-run', result);
    recordE2E(evalCollector, '/land-and-deploy first-run', 'Land-and-Deploy first-run E2E', result);
    expect(result.exitReason).toBe('success');

    // Verify dry-run report was created
    const reportDir = path.join(firstRunDir, '.gstack', 'deploy-reports');
    expect(fs.existsSync(reportDir)).toBe(true);

    // Check report content mentions platform detection
    const reportFiles = fs.readdirSync(reportDir);
    expect(reportFiles.length).toBeGreaterThan(0);
    const reportContent = fs.readFileSync(path.join(reportDir, reportFiles[0]), 'utf-8');
    const hasPlatform = reportContent.toLowerCase().includes('fly') || reportContent.toLowerCase().includes('first-run-app');
    expect(hasPlatform).toBe(true);
  }, CAPTURE_LONG_MS);
});

// --- Land-and-Deploy Review Gate E2E ---

describeIfSelected('Land-and-Deploy review gate E2E', ['land-and-deploy-review-gate'], () => {
  let reviewDir: string;

  beforeAll(() => {
    reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-land-review-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: reviewDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(reviewDir, 'app.ts'), 'export function hello() { return "world"; }\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    // Create 6 more commits to make any review stale
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(reviewDir, `file${i}.ts`), `export const x${i} = ${i};\n`);
      run('git', ['add', '.']);
      run('git', ['commit', '-m', `feat: add file${i}`]);
    }

    copyDirSync(path.join(ROOT, 'land-and-deploy'), path.join(reviewDir, 'land-and-deploy'));
  });

  afterAll(() => {
    try { fs.rmSync(reviewDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('land-and-deploy-review-gate', async () => {
    const result = await runSkillTest({
      prompt: `Read land-and-deploy/SKILL.md for the /land-and-deploy skill instructions.
The Step 3.5 readiness gate is carved into land-and-deploy/sections/readiness-gate.md
in THIS working directory — read it from there (the STOP-Read pointer's
~/.claude/skills/gstack/... path does not exist here).

Focus on Step 3.5a and Step 3.5a-bis.

gstack-review-read is not installed here; it would print NO_REVIEWS for this repo.
This run is non-interactive and the repo has no remote, so there is no PR and gh is
unavailable. Run the readiness gate and save its readiness report under
.gstack/deploy-reports/.`,
      workingDirectory: reviewDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: CAPTURE_MS,
      testName: 'land-and-deploy-review-gate',
      runId,
    });

    logCost('/land-and-deploy review-gate', result);
    recordE2E(evalCollector, '/land-and-deploy review-gate', 'Land-and-Deploy review gate E2E', result);
    expect(result.exitReason).toBe('success');

    // Verify readiness report was created
    const reportDir = path.join(reviewDir, '.gstack', 'deploy-reports');
    expect(fs.existsSync(reportDir)).toBe(true);

    const reportFiles = fs.readdirSync(reportDir);
    expect(reportFiles.length).toBeGreaterThan(0);
    const reportContent = fs.readFileSync(path.join(reportDir, reportFiles[0]), 'utf-8');
    // The prompt no longer supplies the verdict: the gate must record the
    // missing review itself.
    expect(reportContent).toMatch(/review/i);
    expect(reportContent, 'readiness report records the missing review').toMatch(/not run|no reviews?\b|never run|missing/i);
  }, CAPTURE_LONG_MS);
});

// --- Canary skill E2E ---

describeIfSelected('Canary skill E2E', ['canary-workflow'], () => {
  let canaryDir: string;

  beforeAll(() => {
    canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-canary-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: canaryDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(canaryDir, 'index.html'), '<h1>Hello</h1>\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    copyDirSync(path.join(ROOT, 'canary'), path.join(canaryDir, 'canary'));
  });

  afterAll(() => {
    try { fs.rmSync(canaryDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('canary-workflow', async () => {
    const result = await runSkillTest({
      prompt: `Read canary/SKILL.md for the /canary skill instructions.

You are simulating a canary check. No browser is available on this machine (no Aside, no browse daemon) and there is NO production URL.

Instead, demonstrate you understand the workflow:
1. Create the .gstack/canary-reports/ directory structure
2. Write a simulated baseline.json to .gstack/canary-reports/baseline.json with the
   schema described in Phase 2 of the skill (url, timestamp, branch, pages with
   screenshot path, console_errors count, and load_time_ms)
3. Write a simulated canary report to .gstack/canary-reports/canary-report.md following
   the Phase 6 Health Report format (CANARY REPORT header, duration, pages, status,
   per-page results table, verdict)

Do NOT use AskUserQuestion. Do NOT run aside or browse ($B) commands.
Just create the directory structure and report files showing the correct schema.`,
      workingDirectory: canaryDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob'],
      timeout: CAPTURE_MS,
      testName: 'canary-workflow',
      runId,
    });

    logCost('/canary', result);
    recordE2E(evalCollector, '/canary workflow', 'Canary skill E2E', result);
    expect(result.exitReason).toBe('success');

    expect(fs.existsSync(path.join(canaryDir, '.gstack', 'canary-reports'))).toBe(true);
    const reportDir = path.join(canaryDir, '.gstack', 'canary-reports');
    const files = fs.readdirSync(reportDir, { recursive: true }) as string[];
    expect(files.length).toBeGreaterThan(0);
  }, CAPTURE_LONG_MS);
});

// --- Benchmark skill E2E ---

describeIfSelected('Benchmark skill E2E', ['benchmark-workflow'], () => {
  let benchDir: string;

  beforeAll(() => {
    benchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-benchmark-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: benchDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(benchDir, 'index.html'), '<h1>Hello</h1>\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    copyDirSync(path.join(ROOT, 'benchmark'), path.join(benchDir, 'benchmark'));
  });

  afterAll(() => {
    try { fs.rmSync(benchDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('benchmark-workflow', async () => {
    const result = await runSkillTest({
      prompt: `Read benchmark/SKILL.md for the /benchmark skill instructions.

You are simulating a benchmark run. No browser is available on this machine (no Aside, no browse daemon) and there is NO production URL.

Instead, demonstrate you understand the workflow:
1. Create the .gstack/benchmark-reports/ directory structure including baselines/
2. Write a simulated baseline.json to .gstack/benchmark-reports/baselines/baseline.json
   with the schema from Phase 4 (url, timestamp, branch, pages with ttfb_ms, fcp_ms,
   lcp_ms, dom_interactive_ms, dom_complete_ms, full_load_ms, total_requests,
   total_transfer_bytes, js_bundle_bytes, css_bundle_bytes, largest_resources)
3. Write a simulated benchmark report to .gstack/benchmark-reports/benchmark-report.md
   following the Phase 5 comparison format (PERFORMANCE REPORT header, page comparison
   table with Baseline/Current/Delta/Status columns, regression thresholds applied)
4. Include the Phase 7 Performance Budget section in the report

Do NOT use AskUserQuestion. Do NOT run aside or browse ($B) commands.
Just create the files showing the correct schema and report format.`,
      workingDirectory: benchDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob'],
      timeout: CAPTURE_MS,
      testName: 'benchmark-workflow',
      runId,
    });

    logCost('/benchmark', result);
    recordE2E(evalCollector, '/benchmark workflow', 'Benchmark skill E2E', result);
    expect(result.exitReason).toBe('success');

    expect(fs.existsSync(path.join(benchDir, '.gstack', 'benchmark-reports'))).toBe(true);
    const baselineDir = path.join(benchDir, '.gstack', 'benchmark-reports', 'baselines');
    if (fs.existsSync(baselineDir)) {
      const files = fs.readdirSync(baselineDir);
      expect(files.length).toBeGreaterThan(0);
    }
  }, CAPTURE_LONG_MS);
});

// --- Setup-Deploy skill E2E ---

describeIfSelected('Setup-Deploy skill E2E', ['setup-deploy-workflow'], () => {
  let setupDir: string;

  beforeAll(() => {
    setupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-setup-deploy-'));
    const run = (cmd: string, args: string[]) =>
      spawnSync(cmd, args, { cwd: setupDir, stdio: 'pipe', timeout: 5000 });

    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);

    fs.writeFileSync(path.join(setupDir, 'app.ts'), 'export default { port: 3000 };\n');
    fs.writeFileSync(path.join(setupDir, 'fly.toml'), 'app = "my-cool-app"\n\n[http_service]\n  internal_port = 3000\n  force_https = true\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial']);

    copyDirSync(path.join(ROOT, 'setup-deploy'), path.join(setupDir, 'setup-deploy'));
  });

  afterAll(() => {
    try { fs.rmSync(setupDir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('setup-deploy-workflow', async () => {
    const result = await runSkillTest({
      prompt: `Read setup-deploy/SKILL.md for the /setup-deploy skill instructions.

This repo has a fly.toml with app = "my-cool-app". Run the /setup-deploy workflow:
1. Detect the platform from fly.toml (should be Fly.io)
2. Extract the app name: my-cool-app
3. Infer production URL: https://my-cool-app.fly.dev
4. Set deploy status command: fly status --app my-cool-app
5. Write the Deploy Configuration section to CLAUDE.md

Do NOT use AskUserQuestion. Do NOT run fly or gh commands.
Do NOT try to verify the health check URL (there is no network).
Just detect the platform and write the config.`,
      workingDirectory: setupDir,
      maxTurns: 15,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      timeout: CAPTURE_MS,
      testName: 'setup-deploy-workflow',
      runId,
    });

    logCost('/setup-deploy', result);
    recordE2E(evalCollector, '/setup-deploy workflow', 'Setup-Deploy skill E2E', result);
    expect(result.exitReason).toBe('success');

    const claudeMd = path.join(setupDir, 'CLAUDE.md');
    expect(fs.existsSync(claudeMd)).toBe(true);

    const content = fs.readFileSync(claudeMd, 'utf-8');
    expect(content.toLowerCase()).toContain('fly');
    expect(content).toContain('my-cool-app');
    expect(content).toContain('Deploy Configuration');
  }, CAPTURE_LONG_MS);
});

// Module-level afterAll — finalize eval collector after all tests complete
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
