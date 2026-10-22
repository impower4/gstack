import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { committedImageBuildMatrix } from '../scripts/cso-image-matrix';
import { dispatchSourceCommit, stagingRunId, verifyStagingRun, type StagingRunEvidence } from '../scripts/cso-staging-run';

const ROOT = resolve(import.meta.dir, '..');
const REPOSITORY = 'garrytan/gstack';
const RUN_ID = '34980146643';
const COMMIT = 'a'.repeat(40);
const RUNTIME_IDS = committedImageBuildMatrix().include.map(row => row.runtimeId);
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function invocation(runId = RUN_ID, attempt = 1, repository = REPOSITORY): string {
  return `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`;
}

// Shape of one `gh attestation verify --format json` entry for an actions/attest provenance statement.
function verified(predicateInvocation = invocation(), certificateInvocation = predicateInvocation): unknown[] {
  return [{
    attestation: { bundle: {} },
    verificationResult: {
      mediaType: 'application/vnd.dev.sigstore.verificationresult+json;version=0.1',
      signature: { certificate: {
        subjectAlternativeName: `https://github.com/${REPOSITORY}/.github/workflows/cso-runtime-images.yml@refs/heads/main`,
        githubWorkflowTrigger: 'workflow_dispatch',
        sourceRepositoryDigest: COMMIT,
        runInvocationURI: certificateInvocation,
      } },
      statement: {
        _type: 'https://in-toto.io/Statement/v1',
        predicateType: 'https://slsa.dev/provenance/v1',
        subject: [{ name: 'ghcr.io/garrytan/gstack/cso-staging/node-amd64', digest: { sha256: 'b'.repeat(64) } }],
        predicate: {
          buildDefinition: { externalParameters: { workflow: { path: '.github/workflows/cso-runtime-images.yml', ref: 'refs/heads/main' } } },
          runDetails: { builder: { id: 'builder' }, metadata: { invocationId: predicateInvocation } },
        },
      },
    },
  }];
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(RUN_ID), path: '.github/workflows/cso-runtime-images.yml', event: 'workflow_dispatch',
    head_branch: 'main', head_sha: COMMIT, status: 'completed', conclusion: 'success', run_attempt: 2,
    repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, ...overrides,
  };
}

function jobs(): Array<Record<string, unknown>> {
  const job = (name: string) => ({ name, run_id: Number(RUN_ID), status: 'completed', conclusion: 'success' });
  return [
    job('reviewed-inputs'),
    { ...job('validate-native'), conclusion: 'skipped' },
    ...RUNTIME_IDS.map(id => job(`stage (${id})`)),
    ...RUNTIME_IDS.map(id => job(`qualify-native ${id}`)),
  ];
}

function pages(list = jobs(), size = 100): unknown[] {
  const result: unknown[] = [];
  for (let start = 0; start < list.length; start += size) result.push({ total_count: list.length, jobs: list.slice(start, start + size) });
  return result;
}

function evidence(overrides: Partial<StagingRunEvidence> = {}): StagingRunEvidence {
  return { repository: REPOSITORY, runId: RUN_ID, sourceCommit: COMMIT, runtimeIds: RUNTIME_IDS, run: run(), jobPages: pages(), ...overrides };
}

describe('CSO staging run binding', () => {
  test('the committed matrix has the ten native rows the ingress requires', () => {
    expect(RUNTIME_IDS).toHaveLength(10);
  });

  test('resolves one staging run from every image provenance, across rerun attempts', () => {
    const all = RUNTIME_IDS.map((_, index) => verified(invocation(RUN_ID, index === 0 ? 2 : 1)));
    expect(stagingRunId(REPOSITORY, all)).toBe(RUN_ID);
  });

  test('rejects statements that resolve to different runs, foreign repositories, or forged invocations', () => {
    const split = RUNTIME_IDS.map((_, index) => verified(invocation(index === 3 ? '999' : RUN_ID)));
    expect(() => stagingRunId(REPOSITORY, split)).toThrow('STAGING_RUN_NOT_UNIQUE');
    const twoInOne = [[...verified(), ...verified(invocation('999'))]];
    expect(() => stagingRunId(REPOSITORY, twoInOne)).toThrow('STAGING_RUN_NOT_UNIQUE');
    expect(() => stagingRunId(REPOSITORY, [verified(invocation(RUN_ID, 1, 'someone/fork'))])).toThrow('STAGING_INVOCATION_MISMATCH');
    expect(() => stagingRunId(REPOSITORY, [verified(invocation(), invocation('999'))])).toThrow('STAGING_INVOCATION_MISMATCH');
    expect(() => stagingRunId(REPOSITORY, [verified(`${invocation()}/extra`)])).toThrow('STAGING_INVOCATION_MISMATCH');
    const sbom = verified() as any[];
    sbom[0].verificationResult.statement.predicateType = 'https://spdx.dev/Document/v2.3';
    expect(() => stagingRunId(REPOSITORY, [sbom])).toThrow('INVALID_STAGING_PROVENANCE');
    expect(() => stagingRunId(REPOSITORY, [[]])).toThrow('INVALID_STAGING_PROVENANCE');
    expect(() => stagingRunId(REPOSITORY, [])).toThrow('INVALID_STAGING_PROVENANCE');
  });

  test('accepts the successful protected-main staging dispatch with every native gate passed, across job pages', () => {
    expect(() => verifyStagingRun(evidence())).not.toThrow();
    expect(() => verifyStagingRun(evidence({ jobPages: pages(jobs(), 7) }))).not.toThrow();
  });

  test('rejects a run that is not the successful protected-main staging dispatch at the statements commit', () => {
    expect(() => verifyStagingRun(evidence({ run: run({ path: '.github/workflows/cso-runtime-qualification.yml' }) }))).toThrow('STAGING_WORKFLOW_MISMATCH');
    expect(() => verifyStagingRun(evidence({ run: run({ head_branch: 'feature' }) }))).toThrow('STAGING_RUN_NOT_PROTECTED_MAIN_DISPATCH');
    expect(() => verifyStagingRun(evidence({ run: run({ event: 'pull_request' }) }))).toThrow('STAGING_RUN_NOT_PROTECTED_MAIN_DISPATCH');
    expect(() => verifyStagingRun(evidence({ run: run({ conclusion: 'failure' }) }))).toThrow('STAGING_RUN_NOT_SUCCESSFUL');
    expect(() => verifyStagingRun(evidence({ run: run({ status: 'in_progress', conclusion: null }) }))).toThrow('STAGING_RUN_NOT_SUCCESSFUL');
    expect(() => verifyStagingRun(evidence({ run: run({ head_sha: 'c'.repeat(40) }) }))).toThrow('STAGING_SOURCE_COMMIT_MISMATCH');
    expect(() => verifyStagingRun(evidence({ run: run({ id: 1 }) }))).toThrow('STAGING_RUN_ID_MISMATCH');
    expect(() => verifyStagingRun(evidence({ run: run({ head_repository: { full_name: 'someone/fork' } }) }))).toThrow('STAGING_REPOSITORY_MISMATCH');
  });

  test('rejects a failed, missing, extra, or truncated native gate job', () => {
    const failed = jobs();
    failed[failed.length - 1].conclusion = 'failure';
    expect(() => verifyStagingRun(evidence({ jobPages: pages(failed) }))).toThrow('STAGING_NATIVE_GATE_NOT_PASSED');
    const skipped = jobs();
    skipped[skipped.length - 1].conclusion = 'skipped';
    expect(() => verifyStagingRun(evidence({ jobPages: pages(skipped) }))).toThrow('STAGING_NATIVE_GATE_NOT_PASSED');
    const missing = jobs().slice(0, -1);
    expect(() => verifyStagingRun(evidence({ jobPages: pages(missing) }))).toThrow('STAGING_NATIVE_JOBS_MISMATCH');
    const extra = [...jobs(), { name: 'qualify-native unexpected', run_id: Number(RUN_ID), status: 'completed', conclusion: 'success' }];
    expect(() => verifyStagingRun(evidence({ jobPages: pages(extra) }))).toThrow('STAGING_NATIVE_JOBS_MISMATCH');
    const truncated = pages(jobs(), 7).slice(0, -1);
    expect(() => verifyStagingRun(evidence({ jobPages: truncated }))).toThrow('INCOMPLETE_STAGING_JOBS');
    const otherRun = jobs();
    otherRun[otherRun.length - 1].run_id = 1;
    expect(() => verifyStagingRun(evidence({ jobPages: pages(otherRun) }))).toThrow('STAGING_NATIVE_GATE_NOT_PASSED');
    expect(() => verifyStagingRun(evidence({ jobPages: [] }))).toThrow('INVALID_STAGING_JOBS');
  });

  test('a dispatch must name one exact source commit', () => {
    const statements = RUNTIME_IDS.map(runtimeId => ({ runtimeId, sourceCommit: COMMIT }));
    expect(dispatchSourceCommit({ client_payload: { statements } })).toBe(COMMIT);
    statements[4].sourceCommit = 'c'.repeat(40);
    expect(() => dispatchSourceCommit({ client_payload: { statements } })).toThrow('STAGING_SOURCE_COMMIT_MISMATCH');
    expect(() => dispatchSourceCommit({ client_payload: { statements: [{ sourceCommit: 'main' }] } })).toThrow('STAGING_SOURCE_COMMIT_MISMATCH');
  });

  test('the workflow command line resolves and verifies the run from retained files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cso-staging-run-')); temps.push(dir);
    const files = RUNTIME_IDS.map(id => {
      const file = join(dir, `${id}.json`);
      writeFileSync(file, JSON.stringify(verified()));
      return file;
    });
    const script = join(ROOT, 'scripts/cso-staging-run.ts');
    const resolved = spawnSync(process.execPath, ['run', script, 'run-id', '--repository', REPOSITORY, ...files], { encoding: 'utf8', timeout: 30_000 });
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(resolved.stdout).toBe(`${RUN_ID}\n`);
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ client_payload: { statements: RUNTIME_IDS.map(runtimeId => ({ runtimeId, sourceCommit: COMMIT })) } }));
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run()));
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify(pages()));
    const args = ['run', script, 'verify', '--repository', REPOSITORY, '--run-id', RUN_ID, '--event', join(dir, 'event.json'), '--run', join(dir, 'run.json'), '--jobs', join(dir, 'jobs.json')];
    const accepted = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });
    expect(accepted.status, accepted.stderr).toBe(0);
    writeFileSync(join(dir, 'run.json'), JSON.stringify(run({ conclusion: 'failure' })));
    const rejected = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000 });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('STAGING_RUN_NOT_SUCCESSFUL');
  });
});
