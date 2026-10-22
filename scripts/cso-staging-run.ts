#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/** Bind a qualification dispatch to the one successful protected-main staging run that signed its images. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonical } from '../lib/cso/contracts';
import { committedImageBuildMatrix } from './cso-image-matrix';

export const STAGING_WORKFLOW_PATH = '.github/workflows/cso-runtime-images.yml';
export const NATIVE_JOB = 'qualify-native';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const INVOCATION = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9][0-9]*)\/attempts\/[1-9][0-9]*$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface StagingRunEvidence {
  repository: string;
  runId: string;
  sourceCommit: string;
  runtimeIds: string[];
  run: unknown;
  jobPages: unknown;
}

/**
 * Resolve the staging run from verified SLSA provenance. The predicate's
 * invocation and the Fulcio certificate's run URI must agree, and every
 * verified statement for every image must name the same run.
 */
export function stagingRunId(repository: string, verifications: unknown[]): string {
  if (!REPOSITORY.test(repository) || verifications.length === 0) throw new Error('INVALID_STAGING_PROVENANCE');
  const runs = new Set<string>();
  for (const verification of verifications) {
    if (!Array.isArray(verification) || verification.length === 0) throw new Error('INVALID_STAGING_PROVENANCE');
    for (const item of verification) {
      const result = (item as any)?.verificationResult;
      if (result?.statement?.predicateType !== SLSA_PROVENANCE) throw new Error('INVALID_STAGING_PROVENANCE');
      const invocation = result.statement.predicate?.runDetails?.metadata?.invocationId;
      const match = typeof invocation === 'string' ? INVOCATION.exec(invocation) : null;
      if (!match || match[1] !== repository || result.signature?.certificate?.runInvocationURI !== invocation) {
        throw new Error('STAGING_INVOCATION_MISMATCH');
      }
      runs.add(match[2]);
    }
  }
  if (runs.size !== 1) throw new Error('STAGING_RUN_NOT_UNIQUE');
  return [...runs][0];
}

/** Every statement in one qualification dispatch names the same staged source commit. */
export function dispatchSourceCommit(event: unknown): string {
  const statements = (event as any)?.client_payload?.statements;
  if (!Array.isArray(statements) || statements.length === 0) throw new Error('INVALID_QUALIFICATION_DISPATCH');
  const commits = new Set(statements.map((statement: any) => statement?.sourceCommit));
  const [commit] = [...commits];
  if (commits.size !== 1 || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('STAGING_SOURCE_COMMIT_MISMATCH');
  return commit;
}

/** The resolved run must be the protected-main staging dispatch at the statements' commit, with every native gate passed. */
export function verifyStagingRun(evidence: StagingRunEvidence): void {
  const { repository, runId, sourceCommit, runtimeIds } = evidence;
  const run = evidence.run as any;
  if (!run || typeof run !== 'object' || String(run.id) !== runId) throw new Error('STAGING_RUN_ID_MISMATCH');
  if (run.path !== STAGING_WORKFLOW_PATH) throw new Error('STAGING_WORKFLOW_MISMATCH');
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) throw new Error('STAGING_REPOSITORY_MISMATCH');
  if (run.event !== 'workflow_dispatch' || run.head_branch !== 'main') throw new Error('STAGING_RUN_NOT_PROTECTED_MAIN_DISPATCH');
  if (run.status !== 'completed' || run.conclusion !== 'success') throw new Error('STAGING_RUN_NOT_SUCCESSFUL');
  if (run.head_sha !== sourceCommit) throw new Error('STAGING_SOURCE_COMMIT_MISMATCH');

  const pages = evidence.jobPages;
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('INVALID_STAGING_JOBS');
  const totals = new Set(pages.map((page: any) => page?.total_count));
  if (pages.some((page: any) => !Array.isArray(page?.jobs)) || totals.size !== 1) throw new Error('INVALID_STAGING_JOBS');
  const jobs = pages.flatMap((page: any) => page.jobs);
  if (jobs.length !== [...totals][0]) throw new Error('INCOMPLETE_STAGING_JOBS');

  const native = jobs.filter((job: any) => typeof job?.name === 'string' && job.name.startsWith(NATIVE_JOB));
  const expected = runtimeIds.map(id => `${NATIVE_JOB} ${id}`).sort();
  if (runtimeIds.length === 0 || canonical(native.map((job: any) => job.name).sort()) !== canonical(expected)) {
    throw new Error('STAGING_NATIVE_JOBS_MISMATCH');
  }
  if (native.some((job: any) => String(job.run_id) !== runId || job.status !== 'completed' || job.conclusion !== 'success')) {
    throw new Error('STAGING_NATIVE_GATE_NOT_PASSED');
  }
}

function readJson(file: string): unknown {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) throw new Error('UNSAFE_STAGING_EVIDENCE_FILE');
  try { return JSON.parse(fs.readFileSync(absolute, 'utf8')); } catch { throw new Error('INVALID_STAGING_EVIDENCE_FILE'); }
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}

if (import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'run-id' && args[0] === '--repository' && args.length >= 3) {
      process.stdout.write(`${stagingRunId(args[1], args.slice(2).map(readJson))}\n`);
    } else if (command === 'verify' && args.length === 10) {
      const event = readJson(option(args, '--event'));
      verifyStagingRun({
        repository: option(args, '--repository'),
        runId: option(args, '--run-id'),
        sourceCommit: dispatchSourceCommit(event),
        runtimeIds: committedImageBuildMatrix().include.map(row => row.runtimeId),
        run: readJson(option(args, '--run')),
        jobPages: readJson(option(args, '--jobs')),
      });
      process.stdout.write('STAGING RUN VERIFIED\n');
    } else {
      throw new Error('Usage: cso-staging-run.ts run-id --repository OWNER/REPO PROVENANCE.json... | verify --repository OWNER/REPO --run-id ID --event EVENT.json --run RUN.json --jobs JOB-PAGES.json');
    }
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'STAGING_RUN_VERIFICATION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
