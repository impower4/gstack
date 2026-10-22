import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { JUDGE_MS, CAPTURE_MS } from './helpers/eval-budgets';
import { runSkillTest, SESSION_DRAIN_GRACE_MS } from './helpers/session-runner';
import { runRecordedOfficeHoursAttempt, OFFICE_HOURS_BUN_GRACE_MS } from './helpers/office-hours-attempt';
import { resolveEvalModel } from '../lib/eval-model';
import {
  ROOT, runId, describeIfSelected, testConcurrentIfSelected,
  logCost, recordE2E, createEvalCollector, finalizeEvalCollector,
} from './helpers/e2e-helpers';
import { extractSkillSections, REVIEW_ARMY_E2E_SECTIONS, sliceBetween } from './helpers/skill-fixture';
import { makeStateMatrixRepo, STATE_MACHINES_CHECKLIST, STATE_MATRIX_FIXTURE, type StateMatrixRepo } from './helpers/state-matrix-fixture';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const evalCollector = createEvalCollector('e2e-review-army');
// Let capture cleanup and assertions settle before Bun retries or
// removes its shared fixture. This adds no model work time.
const CAPTURE_FINALIZE_MS = SESSION_DRAIN_GRACE_MS + 5_000;

// Helper: create a git repo with a feature branch
function setupRepo(prefix: string): { dir: string; run: (cmd: string, args: string[]) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `skill-e2e-${prefix}-`));
  const run = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 5000 });
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'test@test.com']);
  run('git', ['config', 'user.name', 'Test']);
  return { dir, run };
}

// Helper: stage review skill files in the test dir. The SKILL.md fixture is
// EXTRACTED (CLAUDE.md: "E2E test fixtures: extract, don't copy") — core
// review workflow + Step 1.5 (Plan Completion Audit) + Step 4.5 (Review Army
// dispatch: quality score, JSON schema, consensus, Red Team).
//
// /review is carved (T9): the Step 4.5 dispatch body lives in
// review/sections/review-army.md and the Plan Completion Audit in
// review/sections/plan-completion.md — the skeleton keeps only STOP-Read
// pointers, so the '## Step 4.5' H2 no longer exists in review/SKILL.md.
// Extract the skeleton H2s minus Step 4.5, then append both section files
// (still an extraction: sections ARE the minimal on-demand units).
const REVIEW_ARMY_SKELETON_SECTIONS = REVIEW_ARMY_E2E_SECTIONS.filter(
  (s) => !s.startsWith('Step 4.5'),
);

function readReviewSection(file: string): string {
  const p = path.join(ROOT, 'review', 'sections', file);
  const content = fs.readFileSync(p, 'utf-8');
  // Failure polarity: a fixture is never silently staged empty (regen missing).
  if (content.trim().length < 500) {
    throw new Error(`review section ${file} is unexpectedly small — was gen-skill-docs run after the carve?`);
  }
  return content;
}

function copyReviewFiles(dir: string) {
  fs.writeFileSync(
    path.join(dir, 'review-SKILL.md'),
    [
      extractSkillSections(path.join(ROOT, 'review'), REVIEW_ARMY_SKELETON_SECTIONS),
      readReviewSection('plan-completion.md'),
      readReviewSection('review-army.md'),
    ].join('\n'),
  );
  fs.copyFileSync(path.join(ROOT, 'review', 'checklist.md'), path.join(dir, 'review-checklist.md'));
  fs.copyFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), path.join(dir, 'review-greptile-triage.md'));
  // Copy specialist checklists
  const specDir = path.join(dir, 'review-specialists');
  fs.mkdirSync(specDir, { recursive: true });
  const specialistsRoot = path.join(ROOT, 'review', 'specialists');
  for (const f of fs.readdirSync(specialistsRoot)) {
    fs.copyFileSync(path.join(specialistsRoot, f), path.join(specDir, f));
  }
}

// --- Review Army: Migration Safety ---

describeIfSelected('Review Army: Migration Safety', ['review-army-migration-safety'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-migration');
    dir = repo.dir;

    // Base commit
    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    // Feature branch with unsafe migration
    repo.run('git', ['checkout', '-b', 'feature/drop-columns']);
    fs.mkdirSync(path.join(dir, 'db', 'migrate'), { recursive: true });
    const migrationContent = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'review-army-migration.sql'), 'utf-8'
    );
    fs.writeFileSync(path.join(dir, 'db', 'migrate', '20260330_drop_columns.sql'), migrationContent);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'drop email and phone columns']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-migration-safety', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch with a database migration that drops columns.
Read review-SKILL.md for instructions. Also read review-checklist.md.
The specialist checklists are in review-specialists/ (testing.md, security.md, performance.md, data-migration.md, etc.).

Skip the preamble, lake intro, telemetry sections.
Run Step 4 (Critical pass) then Step 4.5 (Review Army — Specialist Dispatch).
The base branch is main. Run gstack-diff-scope style analysis on the changed files.
Since db/migrate/ files changed, the Data Migration specialist should activate.

For the specialist dispatch, instead of launching subagents, just read review-specialists/data-migration.md
and apply it yourself against the diff (git diff main...HEAD).

Write your findings to ${dir}/review-output.md`,
      workingDirectory: dir,
      maxTurns: 20,
      timeout: CAPTURE_MS,
      testName: 'review-army-migration-safety',
      runId,
    });

    logCost('/review army migration', result);
    recordE2E(evalCollector, '/review army migration safety', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    // Verify migration issues were caught
    const outputPath = path.join(dir, 'review-output.md');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
      const hasMigrationFinding =
        content.includes('drop') ||
        content.includes('data loss') ||
        content.includes('reversib') ||
        content.includes('migration') ||
        content.includes('column');
      expect(hasMigrationFinding).toBe(true);
    }
  }, CAPTURE_MS);
});

// Review Army sessions whose contract starts at specialist dispatch (N+1, consensus).
// The fixture records the Step 4.5 stages before dispatch (scope detection, specialist
// stats, learnings, the diff) and stages only the Review Army section and the named
// checklists, so the session does not spend its budget on the core pass, QA loading,
// web research or a long report. Each case's scope flags are gstack-diff-scope's
// output for its fixture before staging, recorded rather than rerun so the free
// controls stay runnable without bash. A subagent outside a case's contract (the
// consensus case's Red Team) is supplied as a labeled recorded result.
function stageReviewArmySession(dir: string, scopeFlags: string, specialists: string[], checklists: string[]): string {
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 5000 }).stdout ?? '';
  const diff = git(['diff', 'main...HEAD']);
  if (!diff.includes('diff --git')) throw new Error(`Review Army fixture in ${dir} has an empty diff against main`);
  const diffLines = [...git(['diff', '--shortstat', 'main...HEAD']).matchAll(/(\d+) (?:insertion|deletion)/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  fs.writeFileSync(path.join(dir, 'review-army.md'), readReviewSection('review-army.md'));
  const specDir = path.join(dir, 'review-specialists');
  fs.mkdirSync(specDir, { recursive: true });
  for (const name of checklists) {
    fs.copyFileSync(path.join(ROOT, 'review', 'specialists', `${name}.md`), path.join(specDir, `${name}.md`));
  }
  return `$ gstack-diff-scope main
${scopeFlags}
STACK: unknown
DIFF_LINES: ${diffLines}
TEST_FW: unknown
$ gstack-specialist-stats
SPECIALIST_STATS: 0 reviews analyzed
${specialists.map(name => `$ gstack-learnings-search --type pitfall --query "${name}" --limit 5
(no output: no past learnings)`).join('\n')}
$ git diff $(git merge-base main HEAD)
${diff.trimEnd()}`;
}

function reviewArmyScope(observations: string, stages: string): string {
  return `The base branch is main. There is no origin remote, so use main wherever the workflow says origin/<base>.

This capture covers only Step 4.5 (Review Army), ${stages}. Read review-army.md once: it is that workflow.
The core Step 4 pass, Exploratory QA, adversarial review, web research, Fix-First and review-log persistence are outside this capture; do not run or load them. Do not edit source.
The fixture already ran the workflow's detect-scope, specialist-stats and learnings commands and the diff. Use these recorded outputs instead of rerunning them:
\`\`\`
${observations}
\`\`\``;
}

function reviewArmyChecklists(checklists: string[]): string {
  const paths = checklists.map(name => `review-specialists/${name}.md`);
  return `The checklists for this capture are ${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}; give subagents those paths.`;
}

// --- Review Army: N+1 Performance ---
// Contract: Step 4.5 selection -> a foreground Performance specialist -> the Step 4.6
// merge -> the conditional Red Team -> a report that surfaces the N+1.

let nPlusOneCaptureSequence = 0;

describeIfSelected('Review Army: N+1 Performance', ['review-army-perf-n-plus-one'], () => {
  let dir: string;
  let observations: string;

  beforeAll(() => {
    const repo = setupRepo('army-n-plus-one');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/add-posts-index']);
    const n1Content = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'review-army-n-plus-one.rb'), 'utf-8'
    );
    fs.writeFileSync(path.join(dir, 'posts_controller.rb'), n1Content);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add posts controller']);

    observations = stageReviewArmySession(dir, `SCOPE_FRONTEND=false
SCOPE_BACKEND=true
SCOPE_PROMPTS=false
SCOPE_TESTS=false
SCOPE_DOCS=false
SCOPE_CONFIG=false
SCOPE_MIGRATIONS=false
SCOPE_API=true
SCOPE_AUTH=false`, ['performance'], ['performance', 'red-team']);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-perf-n-plus-one', async () => {
    const result = await runSkillTest({
      prompt: `You are the /review parent on branch feature/add-posts-index, a Ruby controller change. The caller invoked /review --performance.
${reviewArmyScope(observations, 'its Step 4.6 merge and the Red Team dispatch')}
Selection: --performance force-includes the Performance specialist despite the small diff; dispatch no other specialist. ${reviewArmyChecklists(['performance', 'red-team'])}
The Performance focus does not waive the skill's conditional Red Team dispatch. If a specialist
produces a CRITICAL finding, dispatch a separate foreground Red Team subagent and merge its findings.

Write ${dir}/review-output.md with only the selection line, the SPECIALIST REVIEW block with its PR Quality Score, and the Red Team result, in at most 30 lines. After saving the report,
finish with a brief acknowledgement rather than repeating the findings in the final response.`,
      workingDirectory: dir,
      maxTurns: 20,
      timeout: CAPTURE_MS,
      testName: 'review-army-perf-n-plus-one',
      runId: `${process.env.EVALS_RUN_ID ?? runId}-review-n-plus-one-${process.pid}-${++nPlusOneCaptureSequence}`,
    });

    logCost('/review army n+1', result);
    let passed = false;
    try {
      expect(result.exitReason).toBe('success');
      expect(result.toolCalls.some(call =>
        ['Agent', 'Task'].includes(call.tool)
        && /\bred[ -]team\b/i.test(call.input.description ?? call.input.subagent_type ?? '')
        && call.input.run_in_background === false,
      )).toBe(true);
      const foreground = result.toolCalls.filter(call =>
        ['Agent', 'Task'].includes(call.tool) && call.input.run_in_background === false);
      const label = (call: { input: any }) => call.input.description ?? call.input.subagent_type ?? '';
      const isRedTeam = (call: { input: any }) => /\bred[ -]team\b/i.test(label(call));
      const performance = foreground.findIndex(call => /\bperformance\b/i.test(label(call)) && !isRedTeam(call));
      expect(performance).toBeGreaterThanOrEqual(0);
      expect(foreground.findIndex(isRedTeam)).toBeGreaterThan(performance);

      const outputPath = path.join(dir, 'review-output.md');
      expect(fs.existsSync(outputPath)).toBe(true);
      const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
      const hasN1Finding =
        content.includes('n+1') ||
        content.includes('n + 1') ||
        content.includes('eager') ||
        content.includes('includes') ||
        content.includes('preload') ||
        content.includes('query') ||
        content.includes('loop');
      expect(hasN1Finding).toBe(true);
      passed = result.browseErrors.length === 0;
    } finally {
      recordE2E(evalCollector, '/review army N+1 detection', 'Review Army', result, { passed });
    }
  }, CAPTURE_MS + CAPTURE_FINALIZE_MS);
});

// --- Review Army: Delivery Audit ---

describeIfSelected('Review Army: Delivery Audit', ['review-army-delivery-audit'], () => {
  let dir: string;
  let observations: string;

  beforeAll(() => {
    const repo = setupRepo('army-delivery');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/three-features']);

    // Write a plan file promising 3 features
    fs.writeFileSync(path.join(dir, 'PLAN.md'), `# Feature Plan

## Implementation Items
1. Add user authentication with login/logout
2. Add user profile page with avatar upload
3. Add email notification system for new signups

## Test Items
- Test login flow
- Test profile page rendering
- Test email sending
`);
    repo.run('git', ['add', 'PLAN.md']);
    repo.run('git', ['commit', '-m', 'add plan']);

    // Implement only 2 of 3 features
    fs.writeFileSync(path.join(dir, 'auth.rb'), `class AuthController
  def login
    # authenticate user
    session[:user_id] = user.id
  end

  def logout
    session.delete(:user_id)
  end
end
`);
    fs.writeFileSync(path.join(dir, 'profile.rb'), `class ProfileController
  def show
    @user = User.find(params[:id])
  end

  def update_avatar
    @user.avatar.attach(params[:avatar])
  end
end
`);
    // NOTE: email notification system is NOT implemented (intentionally missing)
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'implement auth and profile features']);

    // PR lane 36794871032 timed out at 120 s: the session read the 46 KB extracted
    // SKILL in three passes, logged a learning and rewrote a 74-line report. Stage only
    // the audit section and record its git reads, as the Step 4.5 cases do.
    const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 5000 }).stdout ?? '';
    const diff = git(['diff', 'main...HEAD']);
    if (!diff.includes('auth.rb') || !diff.includes('profile.rb')) throw new Error('Delivery audit fixture diff is missing auth.rb or profile.rb');
    observations = `$ git log main..HEAD --oneline
${git(['log', 'main..HEAD', '--oneline']).trimEnd()}
$ git diff main...HEAD
${diff.trimEnd()}`;
    fs.writeFileSync(path.join(dir, 'plan-completion.md'), readReviewSection('plan-completion.md'));
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-delivery-audit', async () => {
    const result = await runSkillTest({
      prompt: `You are the /review parent on branch feature/three-features.
There is a PLAN.md file that promises 3 features: auth, profile, and email notifications.
The diff (git diff main...HEAD) only implements 2 of them (auth and profile).
The base branch is main. There is no origin remote, so use main wherever the workflow says origin/<base>.

This capture covers only Step 1.5's Plan Completion Audit. Read plan-completion.md once: it is that workflow.
The plan file is at ./PLAN.md. Cross-reference it against the diff.
The HIGH-impact discrepancy question, its Scope Check, learnings logging and the later review steps are outside this capture; do not run them. Do not edit source.
The fixture already ran the audit's git commands. Use these recorded outputs instead of rerunning them:
\`\`\`
${observations}
\`\`\`

For each plan item, classify as DONE, PARTIAL, NOT DONE, or CHANGED.
The email notification system should be classified as NOT DONE.

Write ${dir}/review-output.md with only the PLAN COMPLETION AUDIT block and a DISCREPANCY entry for each PARTIAL or NOT DONE item, in at most 30 lines.`,
      workingDirectory: dir,
      maxTurns: 15,
      timeout: JUDGE_MS,
      testName: 'review-army-delivery-audit',
      runId,
    });

    logCost('/review army delivery', result);
    recordE2E(evalCollector, '/review army delivery audit', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const outputPath = path.join(dir, 'review-output.md');
    if (fs.existsSync(outputPath)) {
      const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
      // Should identify email notifications as NOT DONE
      const hasNotDone =
        content.includes('not done') ||
        content.includes('not_done') ||
        content.includes('missing') ||
        content.includes('not implemented');
      const mentionsEmail =
        content.includes('email') ||
        content.includes('notification');
      expect(hasNotDone).toBe(true);
      expect(mentionsEmail).toBe(true);
    }
  }, CAPTURE_MS);
});

// --- Review Army: Quality Score ---

describeIfSelected('Review Army: Quality Score', ['review-army-quality-score'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-quality');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/add-controller']);
    // Real source for one defect and one legitimate optional simplification.
    fs.writeFileSync(path.join(dir, 'user_controller.rb'), `class UserController
  def create
    User.where("name = '#{params[:name]}'")
  end

  def lookup
    User.find(NumberParser.parse(params[:id]))
  end
end
`);
    fs.writeFileSync(path.join(dir, 'number_parser.rb'), `class NumberParser
  def self.parse(value)
    Integer(value)
  end
end
`);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add user controller']);

    // Use the actual merge stage without copying its classification or score
    // logic into the prompt. The supplied malformed metadata is the regression.
    fs.writeFileSync(path.join(dir, 'review-merge.md'), sliceBetween(
      readReviewSection('review-army.md'), '### Step 4.6: Collect and merge findings', '### Red Team dispatch',
    ));
    fs.writeFileSync(path.join(dir, 'specialist-findings.jsonl'), [
      { severity: 'CRITICAL', advisory: true, confidence: 9, path: 'user_controller.rb', line: 3,
        category: 'injection', summary: 'Interpolating params[:name] into SQL allows injection.',
        fix: 'Use a parameterized query.', fingerprint: 'user_controller.rb:3:injection', specialist: 'security' },
      { severity: 'INFORMATIONAL', advisory: true, confidence: 8, path: 'number_parser.rb', line: 1,
        category: 'stdlib-wrapper', summary: 'The one-method NumberParser wrapper only forwards to Integer.',
        fix: 'Optionally call Integer directly in lookup and remove the wrapper.',
        fingerprint: 'number_parser.rb:1:stdlib-wrapper', specialist: 'simplification', lines_removable: 5 },
    ].map(finding => JSON.stringify(finding)).join('\n') + '\n');
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-quality-score', async () => {
    for (const artifact of ['review-output.md', 'merged-review.json']) fs.rmSync(path.join(dir, artifact), { force: true });
    const before = ['user_controller.rb', 'number_parser.rb'].map(file => fs.readFileSync(path.join(dir, file), 'utf8'));
    const result = await runSkillTest({
      prompt: `Replay the completed specialist results in specialist-findings.jsonl through the actual Collect and merge instructions in review-merge.md. Read user_controller.rb and number_parser.rb to verify these findings against the source.
This capture covers only the merge, classification, and scoring stage: do not dispatch additional reviewers, discover unrelated findings, or enter Fix-First. Do not edit application source.
Write the standard merged findings report to ${dir}/review-output.md.
Also write ${dir}/merged-review.json as one JSON object with findings (all final merged finding records, including optional advice), critical_count, informational_count, issues_found (defect count), and quality_score. Preserve each finding's final severity, category, and advisory classification in that artifact, and give each finding record a specialists array naming every specialist source that reported it (an array even when a single specialist did).`,
      workingDirectory: dir,
      maxTurns: 15,
      timeout: JUDGE_MS,
      testName: 'review-army-quality-score',
      runId,
    });

    logCost('/review army quality', result);
    let passed = false, failure: unknown;
    try {
      expect(result.exitReason).toBe('success');
      expect(result.toolCalls.length).toBeGreaterThan(0);
      const outputPath = path.join(dir, 'review-output.md');
      expect(fs.existsSync(outputPath)).toBe(true);
      const content = fs.readFileSync(outputPath, 'utf-8');
      const merged = JSON.parse(fs.readFileSync(path.join(dir, 'merged-review.json'), 'utf8'));
      expect(merged).toMatchObject({ critical_count: 1, informational_count: 0, issues_found: 1, quality_score: 8 });
      expect(merged.findings).toHaveLength(2);
      const defect = merged.findings.find((finding: any) => finding.category === 'injection');
      expect(defect).toMatchObject({ severity: 'CRITICAL' });
      expect(defect.specialists).toEqual(['security']);
      expect(defect.advisory).not.toBe(true);
      const advice = merged.findings.find((finding: any) => finding.category === 'stdlib-wrapper');
      expect(advice).toMatchObject({ severity: 'INFORMATIONAL', advisory: true });
      expect(advice.specialists).toEqual(['simplification']);
      expect(content).toMatch(/SPECIALIST REVIEW:\s*1 findings?\s*\(1 critical, 0 informational\)/i);
      expect(content).toMatch(/PR Quality Score:\s*8(?:\.0)?\/10/i);
      expect(content).toContain('[ADVISORY]');
      expect(['user_controller.rb', 'number_parser.rb'].map(file => fs.readFileSync(path.join(dir, file), 'utf8'))).toEqual(before);
      passed = true;
    } catch (cause) {
      failure = cause;
      throw cause;
    } finally {
      recordE2E(evalCollector, 'review-army-quality-score', 'Review Army', result, {
        passed, error: failure ? String(failure) : undefined,
        exit_reason: passed ? 'success' : result.exitReason === 'success' ? 'assertion_failed' : result.exitReason,
      });
    }
  }, CAPTURE_MS);
});

// --- Review Army: JSON Findings ---

describeIfSelected('Review Army: JSON Findings', ['review-army-json-findings'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-json');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/vuln']);
    fs.writeFileSync(path.join(dir, 'search.rb'), `class SearchController
  def index
    # SQL injection via string interpolation
    results = ActiveRecord::Base.connection.execute(
      "SELECT * FROM products WHERE name LIKE '%#{params[:q]}%'"
    )
    render json: results
  end
end
`);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add search']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-json-findings', async () => {
    const result = await runSkillTest({
      prompt: `You are reviewing a git diff with a SQL injection vulnerability.
Read review-specialists/security.md for the security checklist.

Apply the checklist against this diff (git diff main...HEAD).
Output your findings as JSON objects, one per line, following the schema:
{"severity":"CRITICAL","confidence":9,"path":"search.rb","line":4,"category":"injection","summary":"SQL injection via string interpolation","fix":"Use parameterized query","fingerprint":"search.rb:4:injection","specialist":"security"}

Write ONLY JSON findings (no preamble) to ${dir}/findings.json`,
      workingDirectory: dir,
      maxTurns: 12,
      timeout: JUDGE_MS,
      testName: 'review-army-json-findings',
      runId,
    });

    logCost('/review army json', result);
    recordE2E(evalCollector, '/review army JSON findings', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const findingsPath = path.join(dir, 'findings.json');
    if (fs.existsSync(findingsPath)) {
      const content = fs.readFileSync(findingsPath, 'utf-8').trim();
      const lines = content.split('\n').filter(l => l.trim());
      // At least one finding
      expect(lines.length).toBeGreaterThanOrEqual(1);
      // Each line should be valid JSON with required fields
      for (const line of lines) {
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        // Required fields per schema
        expect(parsed).toHaveProperty('severity');
        expect(parsed).toHaveProperty('confidence');
        expect(parsed).toHaveProperty('path');
        expect(parsed).toHaveProperty('category');
        expect(parsed).toHaveProperty('summary');
        expect(parsed).toHaveProperty('specialist');
        break; // One valid line is enough for the gate test
      }
    }
  }, JUDGE_MS);
});

// --- Review Army: State-machine round-trip matrix (field list 2, W3) ---
// Contract: on the #6792-shaped diff (two new proposal kinds that fall through
// to the remove path, tests only for add, remove and a new-claim replace), the
// live State Machines specialist, given Step 4.5's dispatch instructions
// extracted from review-army.md, returns a matrix that gstack-state-matrix
// check passes against the fixture's ground truth: every kind x owner action
// cell, each untested cell reported as a finding. The free regression on a
// captured run is test/state-matrix.test.ts.

describeIfSelected('Review Army: State-machine matrix', ['review-army-state-matrix'], () => {
  let repo: StateMatrixRepo;

  beforeAll(() => {
    repo = makeStateMatrixRepo('skill-e2e-army-state-matrix-');
    const specDir = path.join(repo.work, 'review-specialists');
    fs.mkdirSync(specDir, { recursive: true });
    fs.copyFileSync(STATE_MACHINES_CHECKLIST, path.join(specDir, 'state-machines.md'));
  });

  afterAll(() => { try { fs.rmSync(repo.root, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-state-matrix', async () => {
    const dispatch = sliceBetween(readReviewSection('review-army.md'), '"You are a specialist code reviewer.', '**Subagent configuration:**')
      .trim().replace(/^"|"$/g, '').replace(/\\"/g, '"')
      .replace('{checklist path}', 'review-specialists/state-machines.md').replace('origin/<base>', 'origin/main')
      .replace('{TEST_FW}', 'unknown').replace('{STACK}', 'node').replace("{learnings or 'none'}", 'none');
    const out = path.join(repo.work, 'review-output.jsonl');
    const result = await runSkillTest({
      prompt: `You are the State Machines specialist that /review's Step 4.5 dispatched for branch trust-guard (gstack-state-matrix detect printed SCOPE_STATE_MACHINE=true). These are your dispatch instructions:

${dispatch}

Write your raw output, exactly as those instructions define it, to ${out} and nothing else. After saving it, finish with a brief acknowledgement.`,
      workingDirectory: repo.work,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'review-army-state-matrix',
      runId,
    });

    logCost('/review army state matrix', result);
    recordE2E(evalCollector, '/review army state-machine matrix', 'Review Army', result);
    expect(result.exitReason).toBe('success');
    expect(fs.existsSync(out)).toBe(true);
    const check = spawnSync(path.join(ROOT, 'bin', 'gstack-state-matrix'), ['check', out, '--repo', repo.work, '--expect', path.join(STATE_MATRIX_FIXTURE, 'expect.json')], { cwd: repo.work, encoding: 'utf-8', timeout: 60_000 });
    expect(check.stdout, check.stdout + check.stderr).toMatch(/^STATE_MATRIX_CHECK: ok/m);
    expect(check.status).toBe(0);
  }, 240_000);
});

// --- Review Army: Red Team (periodic) ---

describeIfSelected('Review Army: Red Team', ['review-army-red-team'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-redteam');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/large-change']);
    // Create a large diff (300+ lines)
    const lines: string[] = ['class LargeController'];
    for (let i = 0; i < 100; i++) {
      lines.push(`  def method_${i}`);
      lines.push(`    data = params[:input_${i}]`);
      lines.push(`    process(data)`);
      lines.push('  end');
      lines.push('');
    }
    lines.push('end');
    fs.writeFileSync(path.join(dir, 'large_controller.rb'), lines.join('\n'));
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add large controller']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-red-team', async () => {
    await runRecordedOfficeHoursAttempt({
      collector: evalCollector,
      name: '/review army red team',
      suite: 'Review Army',
      model: process.env.EVALS_MODEL ?? resolveEvalModel('capture'),
      budgetMs: CAPTURE_MS,
      run: (signal) => runSkillTest({
        signal,
        prompt: `You are reviewing a large diff (300+ lines). Read review-SKILL.md.
Skip preamble, lake intro, telemetry.

The diff is large enough to activate the Red Team specialist.
Read review-specialists/red-team.md and apply it against the diff (git diff main...HEAD).
Focus on finding issues that other specialists might miss.

Write your red team findings to ${dir}/review-output.md
Start the file with "RED TEAM REVIEW" on the first line.`,
        workingDirectory: dir,
        maxTurns: 20,
        timeout: CAPTURE_MS,
        testName: 'review-army-red-team',
        runId,
      }),
      validate: async (result) => {
        logCost('/review army red-team', result);
        expect(result.exitReason).toBe('success');

        const outputPath = path.join(dir, 'review-output.md');
        if (fs.existsSync(outputPath)) {
          const content = fs.readFileSync(outputPath, 'utf-8');
          expect(content.toLowerCase()).toMatch(/red team|adversarial/);
        }
      },
    });
  }, CAPTURE_MS + OFFICE_HOURS_BUN_GRACE_MS);
});

// --- Review Army: Consensus (periodic) ---
// Contract: two forced specialists flag the same injection and the Step 4.6 merge
// surfaces it as MULTI-SPECIALIST CONFIRMED.

describeIfSelected('Review Army: Consensus', ['review-army-consensus'], () => {
  let dir: string;
  let observations: string;
  let consensusCaptureSequence = 0;

  beforeAll(() => {
    const repo = setupRepo('army-consensus');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.rb'), '# base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/vuln-auth']);
    // SQL injection that both security AND testing specialists should flag
    fs.writeFileSync(path.join(dir, 'auth_controller.rb'), `class AuthController
  def login
    user = User.find_by("email = '#{params[:email]}' AND password = '#{params[:password]}'")
    if user
      session[:user_id] = user.id
      redirect_to root_path
    else
      flash[:error] = "Invalid credentials"
      render :login
    end
  end
end
`);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add auth controller']);

    observations = stageReviewArmySession(dir, `SCOPE_FRONTEND=false
SCOPE_BACKEND=true
SCOPE_PROMPTS=false
SCOPE_TESTS=false
SCOPE_DOCS=false
SCOPE_CONFIG=false
SCOPE_MIGRATIONS=false
SCOPE_API=true
SCOPE_AUTH=true`, ['security', 'testing'], ['security', 'testing']);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-consensus', async () => {
    const result = await runSkillTest({
      prompt: `You are the /review parent reviewing a git diff with a SQL injection in an auth controller, on branch feature/vuln-auth. The caller invoked /review --security --testing.
${reviewArmyScope(observations, 'its Step 4.6 merge and the multi-specialist confirmation')}
Selection: --security and --testing force-include those two specialists despite the small diff; dispatch no other specialist. ${reviewArmyChecklists(['security', 'testing'])}
The Red Team is outside this case's contract. When its activation condition is met, do not dispatch it: use this fixture-supplied (synthetic) Red Team result instead, and label it as supplied in the report: NO FINDINGS

This vulnerability should be caught by BOTH the security specialist (injection vector)
AND the testing specialist (no test for auth bypass).

In your output, if a finding is flagged by multiple perspectives,
mark it as "MULTI-SPECIALIST CONFIRMED" with the confirming categories.

Write ${dir}/review-output.md with only the selection line, the SPECIALIST REVIEW block with its PR Quality Score, and the Red Team result, in at most 30 lines. After saving the report, finish with a brief acknowledgement rather than repeating the findings in the final response.`,
      workingDirectory: dir,
      maxTurns: 20,
      timeout: CAPTURE_MS,
      testName: 'review-army-consensus',
      runId: `${process.env.EVALS_RUN_ID ?? runId}-review-consensus-${process.pid}-${++consensusCaptureSequence}`,
      publicStreamDiagnostics: true,
    });

    logCost('/review army consensus', result);
    let passed = false;
    try {
      expect(result.exitReason).toBe('success');

      const outputPath = path.join(dir, 'review-output.md');
      if (fs.existsSync(outputPath)) {
        const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
        // Should catch the SQL injection
        const hasSqlFinding =
          content.includes('sql') ||
          content.includes('injection') ||
          content.includes('interpolat');
        expect(hasSqlFinding).toBe(true);
      }
      passed = result.browseErrors.length === 0;
    } finally {
      recordE2E(evalCollector, '/review army consensus', 'Review Army', result, { passed });
    }
    // The runner can drain stderr for 5s after exit; reserve 1s for assertions/recording.
  }, CAPTURE_MS + CAPTURE_FINALIZE_MS);
});

// --- Review Army: Simplification specialist (activation) ---

describeIfSelected('Review Army: Simplification activation', ['review-army-simplification'], () => {
  let dir: string;
  let observations: string;

  beforeAll(() => {
    const repo = setupRepo('army-simplification');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.js'), '// base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/date-utils']);
    const overbuild = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'review-army-overbuild.js'), 'utf-8'
    );
    fs.writeFileSync(path.join(dir, 'date_utils.js'), overbuild);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add date utils']);

    observations = stageReviewArmySession(dir, `SCOPE_FRONTEND=false
SCOPE_BACKEND=true
SCOPE_PROMPTS=false
SCOPE_TESTS=false
SCOPE_DOCS=false
SCOPE_CONFIG=false
SCOPE_MIGRATIONS=false
SCOPE_API=false
SCOPE_AUTH=false`, ['simplification'], ['simplification']);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-simplification', async () => {
    const result = await runSkillTest({
      prompt: `You are the /review parent on branch feature/date-utils, a JS utility change. The caller invoked /review --simplification.
${reviewArmyScope(observations, 'its Step 4.6 merge')}
Selection: --simplification force-includes the Simplification specialist; the recorded DIFF_LINES is below its size gate, so only the flag selects it. Dispatch no other specialist.
The checklist for this capture is review-specialists/simplification.md. Instead of launching a subagent, read it and apply it yourself against the recorded diff.

Write ${dir}/review-output.md with only the selection line and the SPECIALIST REVIEW block with its PR Quality Score and Simplification footer, in at most 30 lines. After saving the report, finish with a brief acknowledgement rather than repeating the findings in the final response.`,
      workingDirectory: dir,
      maxTurns: 20,
      timeout: 180_000,
      testName: 'review-army-simplification',
      runId,
    });

    logCost('/review army simplification', result);
    recordE2E(evalCollector, '/review army simplification detection', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const outputPath = path.join(dir, 'review-output.md');
    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf-8').toLowerCase();
    // At least one planted invitation caught, expressed through the closed
    // tag vocabulary or its obvious phrasing.
    const hasStructureFinding =
      content.includes('native') ||
      content.includes('stdlib') ||
      content.includes('speculative') ||
      content.includes('intl') ||
      content.includes('one implementation') ||
      content.includes('single implementation');
    expect(hasStructureFinding).toBe(true);
    // Advisory findings must not read as defects: the disavowed frame stays out.
    expect(content).not.toContain('lean already. ship.');
  }, 210_000);
});

// --- Review Army: Simplification specialist (false-flag precision) ---

describeIfSelected('Review Army: Simplification precision', ['review-army-simplification-precision'], () => {
  let dir: string;

  beforeAll(() => {
    const repo = setupRepo('army-simplification-lean');
    dir = repo.dir;

    fs.writeFileSync(path.join(dir, 'app.js'), '// base\n');
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'initial']);

    repo.run('git', ['checkout', '-b', 'feature/parse-port']);
    const lean = fs.readFileSync(
      path.join(ROOT, 'test', 'fixtures', 'review-army-lean-complete.js'), 'utf-8'
    );
    fs.writeFileSync(path.join(dir, 'parse_port.js'), lean);
    repo.run('git', ['add', '.']);
    repo.run('git', ['commit', '-m', 'add parsePort with self-check']);

    copyReviewFiles(dir);
  });

  afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

  testConcurrentIfSelected('review-army-simplification-precision', async () => {
    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch that adds one small, complete utility (validation + error path + self-check).
Read review-specialists/simplification.md and apply it against the diff of the current branch vs main (git diff main).

Write the specialist's raw output to ${dir}/review-output.md — either the finding JSON lines or the exact NO FINDINGS sentinel.`,
      workingDirectory: dir,
      maxTurns: 12,
      timeout: 150_000,
      testName: 'review-army-simplification-precision',
      runId,
    });

    logCost('/review army simplification precision', result);
    recordE2E(evalCollector, '/review army simplification precision', 'Review Army', result);
    expect(result.exitReason).toBe('success');

    const outputPath = path.join(dir, 'review-output.md');
    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf-8');
    // Precision: a lean, complete diff yields no simplification findings.
    // The specialist must not flag the error path or the self-check for
    // deletion — that is the noise failure mode this case pins.
    const flaggedTestOrErrorPath =
      /"category"\s*:\s*"(delete|shrink|stdlib|native|speculative)"/i.test(content) &&
      /(testparseport|self-check|assert|throw)/i.test(content);
    expect(flaggedTestOrErrorPath).toBe(false);
    expect(content.toUpperCase()).toContain('NO FINDINGS');
  }, 180_000);
});

// Finalize eval collector
afterAll(async () => {
  await finalizeEvalCollector(evalCollector);
});
