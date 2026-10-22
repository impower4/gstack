#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/** Generate a reviewable catalog candidate from authenticated qualification statements. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonical, sha256 as sha256Hex } from '../lib/cso/contracts';
import committedCatalog from '../lib/cso/runtime-catalog.json';
import buildInputs from '../lib/cso/images/build-inputs.json';
import {
  CSO_HELPER_ABI,
  EVALUATION_REVISION_PREFIX,
  isEvaluationRuntimeCatalog,
  validRequalificationTriggers,
  type RequalificationTriggers,
  type QualifiedRuntime,
  type RuntimeCatalog,
  type RuntimeQualification,
  validateRuntimeCatalog,
} from '../lib/cso/runtime-catalog';
import { ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import { imageBuildMatrix, type ImageBuildRow } from './cso-image-matrix';
import { committedPreparation, requalificationTriggers, staleRequalificationTriggers } from './cso-requalification';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WORKFLOW = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/;
const OUTPUT_IMAGE = /^ghcr\.io\/garrytan\/gstack\/cso-staging\/(node|bun|python|rails|postgresql)-(amd64|arm64)@sha256:[a-f0-9]{64}$/;
const MAX_EVIDENCE_FILES = 10;
const MAX_EVIDENCE_BYTES = 1024 * 1024;

export interface RuntimeQualificationStatement {
  schemaVersion: 1;
  helperAbi: 3;
  state: 'qualified';
  buildRevision: string;
  runtimeId: string;
  stack: ImageBuildRow['stack'];
  platform: ImageBuildRow['platform'];
  image: string;
  versions: Record<string, string>;
  sourceCommit: string;
  workflow: string;
  qualifiedAt: string;
  sbomDigest: string;
  provenanceDigest: string;
  checks: Record<string, true>;
}

function sha256(value: string | Buffer): string {
  return `sha256:${sha256Hex(value)}`;
}

function versionsKey(value: Record<string, string>): string {
  return canonical(value);
}

export function requiredChecks(stack: ImageBuildRow['stack']): string[] {
  if (stack === 'postgresql') return [
    'containmentPassed', 'coldStartPassed', 'multiDatabasePassed', 'readinessPassed',
    'secretCanaryPassed', 'watchdogCleanupPassed',
  ].sort();
  const common = [
    'accuracyGatesPassed', 'acquisitionPublicOnlyPassed', 'coldStartPassed', 'containmentPassed',
    'heldOutRepairPassed', 'offlineLifecyclePassed', 'positiveNegativeAssertionsPassed',
    'secretCanaryPassed', 'watchdogCleanupPassed',
  ];
  return stack === 'rails'
    ? [...common, 'nativeExtensionsPassed', 'railsPostgresqlPassed', 'railsSqlitePassed'].sort()
    : common.sort();
}

function qualification(statement: RuntimeQualificationStatement): RuntimeQualification {
  if (statement.stack === 'postgresql') return {
    kind: 'postgresql',
    sourceCommit: statement.sourceCommit,
    workflow: statement.workflow,
    sbomDigest: statement.sbomDigest,
    provenanceDigest: statement.provenanceDigest,
    verifiedProvenance: true,
    containmentPassed: true,
    coldStartPassed: true,
    multiDatabasePassed: true,
    readinessPassed: true,
  };
  return {
    kind: 'application',
    sourceCommit: statement.sourceCommit,
    workflow: statement.workflow,
    sbomDigest: statement.sbomDigest,
    provenanceDigest: statement.provenanceDigest,
    verifiedProvenance: true,
    containmentPassed: true,
    coldStartPassed: true,
    positiveNegativeAssertionsPassed: true,
    heldOutRepairPassed: true,
  };
}

function validateStatement(raw: unknown, row: ImageBuildRow): RuntimeQualificationStatement {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_QUALIFICATION_STATEMENT');
  const statement = raw as RuntimeQualificationStatement;
  const expectedFields = [
    'buildRevision', 'checks', 'helperAbi', 'image', 'platform', 'provenanceDigest',
    'qualifiedAt', 'runtimeId', 'sbomDigest', 'schemaVersion', 'sourceCommit', 'stack',
    'state', 'versions', 'workflow',
  ];
  if (canonical(Object.keys(statement).sort()) !== canonical(expectedFields.sort())) throw new Error('INVALID_QUALIFICATION_STATEMENT_FIELDS');
  if (statement.schemaVersion !== 1 || statement.helperAbi !== CSO_HELPER_ABI || statement.state !== 'qualified') throw new Error('UNQUALIFIED_RUNTIME_EVIDENCE');
  if (statement.buildRevision !== row.inputRevision || statement.runtimeId !== row.runtimeId ||
    statement.stack !== row.stack || statement.platform !== row.platform ||
    versionsKey(statement.versions) !== versionsKey(row.versions)) throw new Error(`QUALIFICATION_BUILD_MISMATCH: ${row.runtimeId}`);
  if (!OUTPUT_IMAGE.test(statement.image) || !statement.image.includes(`/${row.stack}-${row.arch}@`)) throw new Error(`INVALID_QUALIFIED_IMAGE: ${row.runtimeId}`);
  if (!/^[a-f0-9]{40}$/.test(statement.sourceCommit) || !WORKFLOW.test(statement.workflow) ||
    !Number.isFinite(Date.parse(statement.qualifiedAt)) || !DIGEST.test(statement.sbomDigest) ||
    !DIGEST.test(statement.provenanceDigest)) throw new Error(`MISSING_QUALIFICATION_PROVENANCE: ${row.runtimeId}`);
  if (!statement.checks || typeof statement.checks !== 'object' || Array.isArray(statement.checks)) throw new Error(`MISSING_RELEASE_GATES: ${row.runtimeId}`);
  const expected = requiredChecks(row.stack);
  const actual = Object.keys(statement.checks).sort();
  if (canonical(actual) !== canonical(expected) || actual.some(key => statement.checks[key] !== true)) throw new Error(`MISSING_RELEASE_GATES: ${row.runtimeId}`);
  return statement;
}

/** The committed (never evaluation-only) catalog and the reviewed build matrix it must describe. */
function reviewedMatrix(currentValue: unknown, inputValue: unknown): { current: RuntimeCatalog; rows: ImageBuildRow[] } {
  validateRuntimeCatalog(currentValue);
  const current = currentValue as RuntimeCatalog;
  if (isEvaluationRuntimeCatalog(current)) throw new Error('EVALUATION_CATALOG_NOT_PROMOTABLE');
  return { current, rows: profilesMatchingRows(current, inputValue) };
}

function profilesMatchingRows(current: RuntimeCatalog, inputValue: unknown): ImageBuildRow[] {
  const rows = imageBuildMatrix(inputValue).include;
  if (!current.profiles || current.buildRevision !== rows[0].inputRevision) throw new Error('CATALOG_BUILD_REVISION_MISMATCH');
  const profiles = new Map(current.profiles.map(profile => [profile.id, profile]));
  if (profiles.size !== rows.length) throw new Error('CATALOG_PROFILE_MATRIX_MISMATCH');
  for (const row of rows) {
    const profile = profiles.get(row.runtimeId);
    if (!profile || profile.stack !== row.stack || profile.platform !== row.platform ||
      versionsKey(profile.versions) !== versionsKey(row.versions)) throw new Error(`CATALOG_PROFILE_MATRIX_MISMATCH: ${row.runtimeId}`);
  }
  return rows;
}

/** The candidate build's gate: a valid evaluation-only catalog for the reviewed build inputs. */
export function validateEvaluationCandidate(catalogValue: unknown, inputValue: unknown): RuntimeCatalog {
  validateRuntimeCatalog(catalogValue);
  const catalog = catalogValue as RuntimeCatalog;
  if (!isEvaluationRuntimeCatalog(catalog)) throw new Error('NOT_AN_EVALUATION_CATALOG');
  const rows = profilesMatchingRows(catalog, inputValue);
  for (const row of rows) {
    const runtime = catalog.runtimes.find(item => item.id === row.runtimeId);
    if (!runtime || !OUTPUT_IMAGE.test(runtime.image) || !runtime.image.includes(`/${row.stack}-${row.arch}@`)) throw new Error(`INVALID_QUALIFIED_IMAGE: ${row.runtimeId}`);
  }
  return catalog;
}

function matchRows(rows: ImageBuildRow[], values: unknown[]): Array<[ImageBuildRow, unknown]> {
  if (values.length !== rows.length) throw new Error('INCOMPLETE_QUALIFICATION_MATRIX');
  const byId = new Map<string, unknown>();
  for (const value of values) {
    const id = (value as any)?.runtimeId;
    if (typeof id !== 'string' || byId.has(id)) throw new Error('DUPLICATE_QUALIFICATION_STATEMENT');
    byId.set(id, value);
  }
  return rows.map(row => {
    if (!byId.has(row.runtimeId)) throw new Error(`MISSING_QUALIFICATION_STATEMENT: ${row.runtimeId}`);
    return [row, byId.get(row.runtimeId)];
  });
}

const STAGED_FIELDS = [
  'buildRevision', 'helperAbi', 'image', 'platform', 'provenanceDigest', 'qualification', 'runtimeId',
  'sbomDigest', 'schemaVersion', 'sourceCommit', 'stack', 'state', 'verifiedProvenance', 'versions', 'workflow',
].sort();

/**
 * Build an evaluation-only catalog from one staging run's staged-image.json
 * records. It measures no release gate: every runtime is an
 * evaluation_candidate, and setup, distribution builds and promotion refuse it.
 */
export function evaluationCandidateCatalog(currentValue: unknown, inputValue: unknown, stagedValues: unknown[], createdAt: string): RuntimeCatalog {
  const { current, rows } = reviewedMatrix(currentValue, inputValue);
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('INVALID_EVALUATION_TIME');
  const staged = matchRows(rows, stagedValues).map(([row, value]) => {
    const record = value as RuntimeQualificationStatement;
    if (!record || typeof record !== 'object' || canonical(Object.keys(record).sort()) !== canonical(STAGED_FIELDS) ||
      record.schemaVersion !== 1 || record.helperAbi !== CSO_HELPER_ABI || (record.state as string) !== 'staged' || (record as any).verifiedProvenance !== true) throw new Error(`INVALID_STAGED_RUNTIME: ${row.runtimeId}`);
    if (record.buildRevision !== row.inputRevision || record.stack !== row.stack || record.platform !== row.platform ||
      versionsKey(record.versions) !== versionsKey(row.versions)) throw new Error(`QUALIFICATION_BUILD_MISMATCH: ${row.runtimeId}`);
    if (!OUTPUT_IMAGE.test(record.image) || !record.image.includes(`/${row.stack}-${row.arch}@`)) throw new Error(`INVALID_QUALIFIED_IMAGE: ${row.runtimeId}`);
    if (!/^[a-f0-9]{40}$/.test(record.sourceCommit) || !WORKFLOW.test(record.workflow) || !DIGEST.test(record.sbomDigest) ||
      !DIGEST.test(record.provenanceDigest)) throw new Error(`MISSING_QUALIFICATION_PROVENANCE: ${row.runtimeId}`);
    return record;
  });
  if (new Set(staged.map(item => item.sourceCommit)).size !== 1 || new Set(staged.map(item => item.workflow)).size !== 1) throw new Error('SPLIT_STAGING_RUN');
  const { sourceCommit, workflow } = staged[0];
  const runtimes: QualifiedRuntime[] = staged.map(record => ({
    id: record.runtimeId,
    stack: record.stack,
    platform: record.platform,
    state: 'evaluation_candidate',
    image: record.image,
    entrypoint: '/opt/cso/entrypoint',
    helperAbi: CSO_HELPER_ABI,
    versions: record.versions,
    policyVersion: 'cso-isolation-v1',
    qualifiedAt: createdAt,
    qualification: { kind: 'evaluation', sourceCommit, workflow, sbomDigest: record.sbomDigest, provenanceDigest: record.provenanceDigest, verifiedProvenance: true },
  }));
  const candidate: RuntimeCatalog = {
    schemaVersion: 1,
    revision: `${EVALUATION_REVISION_PREFIX}${workflow.slice(workflow.lastIndexOf('/') + 1)}-${sourceCommit.slice(0, 12)}`,
    previousRevision: current.revision,
    helperAbi: CSO_HELPER_ABI,
    buildRevision: current.buildRevision,
    profiles: current.profiles,
    evaluation: { sourceCommit, workflow, evidenceDigest: sha256(canonical(runtimes)) },
    runtimes,
  };
  validateRuntimeCatalog(candidate);
  return candidate;
}

export function catalogPromotionCandidate(
  currentValue: unknown,
  inputValue: unknown,
  evidenceValues: unknown[],
  /** Measured by the staging run at sourceCommit (scripts/cso-requalification.ts triggers). */
  requalification: RequalificationTriggers,
): RuntimeCatalog {
  const { current, rows } = reviewedMatrix(currentValue, inputValue);
  if (!validRequalificationTriggers(requalification, current.buildRevision)) throw new Error('INVALID_REQUALIFICATION_TRIGGERS');
  if (requalification.isolationPolicyHash !== ISOLATION_POLICY_HASH) throw new Error('STALE_RUNTIME_QUALIFICATION: isolationPolicyHash');
  const statements = matchRows(rows, evidenceValues).map(([row, value]) => validateStatement(value, row));
  const sourceCommits = new Set(statements.map(item => item.sourceCommit));
  const workflows = new Set(statements.map(item => item.workflow));
  if (sourceCommits.size !== 1 || workflows.size !== 1) throw new Error('SPLIT_QUALIFICATION_RUN');
  const sourceCommit = statements[0].sourceCommit;
  const workflow = statements[0].workflow;
  const runId = workflow.slice(workflow.lastIndexOf('/') + 1);
  const runtimes: QualifiedRuntime[] = statements.map(statement => ({
    id: statement.runtimeId,
    stack: statement.stack,
    platform: statement.platform,
    state: 'qualified',
    image: statement.image,
    entrypoint: '/opt/cso/entrypoint',
    helperAbi: CSO_HELPER_ABI,
    versions: statement.versions,
    policyVersion: 'cso-isolation-v1',
    qualifiedAt: statement.qualifiedAt,
    qualification: qualification(statement),
  }));
  const qualificationEvidenceDigest = sha256(canonical(statements));
  const evidenceDigest = sha256(canonical(runtimes));
  const candidate: RuntimeCatalog = {
    schemaVersion: 1,
    revision: `cso-v3-${runId}-${sourceCommit.slice(0, 12)}`,
    previousRevision: current.revision,
    helperAbi: CSO_HELPER_ABI,
    buildRevision: current.buildRevision,
    profiles: current.profiles,
    promotion: {
      sourceCommit, workflow, evidenceDigest, qualificationEvidenceDigest,
      requalification: {
        helperAbi: requalification.helperAbi,
        isolationPolicyHash: requalification.isolationPolicyHash,
        preparationSha256: requalification.preparationSha256,
        buildInputsRevision: requalification.buildInputsRevision,
      },
    },
    runtimes,
  };
  validateRuntimeCatalog(candidate);
  return candidate;
}

/**
 * The release contract: the promotion candidate, refused when any trigger moved since the staged commit.
 * A recorded preparationSha256 that differs from the current one is re-measured at the staged commit in
 * `source`, so a staging record made under the legacy rule compares under the current rule.
 */
export async function releaseCandidate(
  evidenceValues: unknown[],
  recorded: RequalificationTriggers,
  current: RequalificationTriggers,
  source?: string,
): Promise<RuntimeCatalog> {
  let candidate = catalogPromotionCandidate(committedCatalog, buildInputs, evidenceValues, recorded);
  if (recorded.preparationSha256 !== current.preparationSha256) {
    const staged = await committedPreparation(candidate.promotion!.sourceCommit, source);
    if (recorded.preparationSha256 !== staged.current && recorded.preparationSha256 !== staged.legacy) {
      throw new Error('REQUALIFICATION_TRIGGERS_MISMATCH: preparationSha256 was not measured at the staged commit');
    }
    candidate = catalogPromotionCandidate(committedCatalog, buildInputs, evidenceValues, { ...recorded, preparationSha256: staged.current });
  }
  const stale = staleRequalificationTriggers(candidate, current);
  if (stale.length) throw new Error(`STALE_RUNTIME_QUALIFICATION: ${stale.join(', ')} changed since the staged commit; re-stage and requalify`);
  return candidate;
}

/** A promotion may only replace the exact catalog revision it was generated from. */
export function validateRuntimeCatalogTransition(currentValue: unknown, proposedValue: unknown): void {
  validateRuntimeCatalog(currentValue);
  validateRuntimeCatalog(proposedValue);
  const current = currentValue as RuntimeCatalog;
  const proposed = proposedValue as RuntimeCatalog;
  if (isEvaluationRuntimeCatalog(current) || isEvaluationRuntimeCatalog(proposed)) throw new Error('EVALUATION_CATALOG_NOT_PROMOTABLE');
  if (!proposed.promotion || proposed.runtimes.length === 0) throw new Error('UNQUALIFIED_RUNTIME_CATALOG_PROMOTION');
  if (proposed.revision === current.revision || proposed.previousRevision !== current.revision) {
    throw new Error('RUNTIME_CATALOG_BASE_REVISION_MISMATCH');
  }
  if (proposed.buildRevision !== current.buildRevision ||
    canonical(proposed.profiles) !== canonical(current.profiles)) {
    throw new Error('RUNTIME_CATALOG_PROFILE_TRANSITION_MISMATCH');
  }
}

function collectEvidence(root: string, name = 'qualified-runtime.json'): unknown[] {
  const absolute = path.resolve(root);
  const rootStat = fs.lstatSync(absolute);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('UNSAFE_EVIDENCE_ROOT');
  const files: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4) throw new Error('EVIDENCE_TREE_TOO_DEEP');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('UNSAFE_EVIDENCE_ENTRY');
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.name === name) files.push(file);
      if (files.length > MAX_EVIDENCE_FILES) throw new Error('TOO_MANY_QUALIFICATION_STATEMENTS');
    }
  };
  visit(absolute, 0);
  return files.sort().map(file => {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_EVIDENCE_BYTES) throw new Error('UNSAFE_QUALIFICATION_STATEMENT');
    const body = fs.readFileSync(file, 'utf8');
    const after = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('QUALIFICATION_EVIDENCE_RACE');
    try { return JSON.parse(body); } catch { throw new Error('INVALID_QUALIFICATION_STATEMENT'); }
  });
}

function readCatalogArtifact(file: string): unknown {
  const absolute = path.resolve(file);
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > MAX_EVIDENCE_BYTES) {
    throw new Error('UNSAFE_RUNTIME_CATALOG_ARTIFACT');
  }
  const body = fs.readFileSync(absolute, 'utf8');
  const after = fs.lstatSync(absolute);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
    before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs) throw new Error('RUNTIME_CATALOG_ARTIFACT_RACE');
  try { return JSON.parse(body); } catch { throw new Error('INVALID_RUNTIME_CATALOG_ARTIFACT'); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'check-evaluation') {
      if (args.length !== 2) throw new Error('Usage: cso-runtime-promotion.ts check-evaluation <cso-eval-catalog>');
      const catalog = validateEvaluationCandidate(readCatalogArtifact(args[1]), buildInputs);
      process.stdout.write(`EVALUATION-ONLY ${catalog.revision}\n`);
    } else if (args[0] === 'evaluation-candidate') {
      if (![5, 7].includes(args.length) || args[1] !== '--staged-root' || args[3] !== '--output' || (args.length === 7 && args[5] !== '--created-at')) {
        throw new Error('Usage: cso-runtime-promotion.ts evaluation-candidate --staged-root <directory> --output <new-file> [--created-at <ISO time>]');
      }
      const candidate = evaluationCandidateCatalog(committedCatalog, buildInputs, collectEvidence(args[2], 'staged-image.json'), args[6] ?? new Date().toISOString());
      const output = path.resolve(args[4]);
      fs.writeFileSync(output, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      process.stdout.write(`${output}\n`);
    } else if (args[0] === 'validate-transition') {
      if (args.length !== 3) throw new Error('Usage: cso-runtime-promotion.ts validate-transition <current-catalog> <proposed-catalog>');
      validateRuntimeCatalogTransition(readCatalogArtifact(args[1]), readCatalogArtifact(args[2]));
      process.stdout.write('VALID TRANSITION\n');
    } else {
      if (args.length !== 4 || args[0] !== '--evidence-root' || args[2] !== '--output') {
        throw new Error('Usage: cso-runtime-promotion.ts --evidence-root <directory> --output <new-file>');
      }
      const triggers = collectEvidence(args[1], 'requalification.json');
      if (triggers.length !== 1) throw new Error('MISSING_REQUALIFICATION_TRIGGERS');
      const candidate = await releaseCandidate(collectEvidence(args[1]), triggers[0] as RequalificationTriggers, await requalificationTriggers());
      const output = path.resolve(args[3]);
      fs.writeFileSync(output, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      process.stdout.write(`${output}\n`);
    }
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : 'RUNTIME_PROMOTION_FAILED') + '\n');
    process.exitCode = 1;
  }
}
