import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import committedCatalog from '../lib/cso/runtime-catalog.json';
import buildInputs from '../lib/cso/images/build-inputs.json';
import { ISOLATION_POLICY_HASH } from '../lib/cso/docker';
import { selectRuntime, validateRuntimeCatalog, type RuntimeCatalog } from '../lib/cso/runtime-catalog';
import { imageSourceFiles, requalificationTriggers, staleRequalificationTriggers } from '../scripts/cso-requalification';
import { catalogPromotionCandidate } from '../scripts/cso-runtime-promotion';
import { completeRuntimeCatalogFixture } from './helpers/cso-runtime-catalog';

const ROOT = resolve(import.meta.dir, '..');
const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const current = await requalificationTriggers();

describe('CSO runtime requalification triggers', () => {
  test('the committed catalog is not older than its trigger inputs', () => {
    expect(staleRequalificationTriggers(committedCatalog as unknown as RuntimeCatalog, current)).toEqual([]);
    const cli = spawnSync(process.execPath, ['scripts/cso-requalification.ts', 'check', 'lib/cso/runtime-catalog.json'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(cli.status, cli.stderr).toBe(0); expect(cli.stdout).toBe('REQUALIFICATION CURRENT\n');
  });

  test.skipIf(process.platform==='win32')('triggers cover the helper ABI, isolation policy, every image-embedded source byte, and the build inputs', async () => {
    expect(current).toMatchObject({ helperAbi: 3, isolationPolicyHash: ISOLATION_POLICY_HASH, buildInputsRevision: buildInputs.revision });
    const files = await imageSourceFiles();
    for (const file of ['lib/cso/verifier.ts', 'lib/cso/preparation-container.ts', 'lib/cso/contracts.ts', 'lib/cso/images/entrypoint', 'lib/cso/images/rails.Dockerfile']) expect(files).toContain(file);
    for (const file of ['lib/cso/images/README.md', 'lib/cso/images/qualification.json', 'lib/cso/images/build-inputs.json', 'lib/cso/cli.ts']) expect(files).not.toContain(file);
    const copy = mkdtempSync(join(tmpdir(), 'cso-requalification-')); temps.push(copy);
    cpSync(join(ROOT, 'lib'), join(copy, 'lib'), { recursive: true });
    expect(await requalificationTriggers(copy)).toEqual(current);
    writeFileSync(join(copy, 'lib/cso/verifier.ts'), '\n', { flag: 'a' });
    expect((await requalificationTriggers(copy)).preparationSha256).not.toBe(current.preparationSha256);
  });

  test.skipIf(process.platform==='win32')('triggers resolve against the repository root from any working directory', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'cso-requalification-cwd-')); temps.push(elsewhere);
    const nested = join(elsewhere, 'a', 'b', 'c'); mkdirSync(nested, { recursive: true });
    const cli = spawnSync(process.execPath, [join(ROOT, 'scripts/cso-requalification.ts'), 'triggers'], { cwd: nested, encoding: 'utf8', timeout: 30_000 });
    expect(cli.status, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout)).toEqual(current);
    const copy = join(elsewhere, 'deeper', 'checkout'); mkdirSync(copy, { recursive: true });
    cpSync(join(ROOT, 'lib'), join(copy, 'lib'), { recursive: true });
    expect(await requalificationTriggers(copy)).toEqual(current);
    expect(await imageSourceFiles(copy)).toEqual(await imageSourceFiles());
  });

  test('a promoted catalog names each trigger that changed after qualification', () => {
    const catalog = completeRuntimeCatalogFixture();
    const recorded = catalog.promotion!.requalification;
    expect(staleRequalificationTriggers(catalog, { ...recorded })).toEqual([]);
    expect(staleRequalificationTriggers(catalog, { ...recorded, preparationSha256: 'd'.repeat(64), buildInputsRevision: 'next-inputs' })).toEqual(['buildInputsRevision', 'preparationSha256']);
    const withdrawn = { ...catalog, runtimes: [], promotion: undefined };
    expect(staleRequalificationTriggers(withdrawn, { ...recorded, preparationSha256: 'd'.repeat(64) })).toEqual([]);
  });

  test('promoted catalogs must record valid triggers, and the helper refuses runtimes qualified under another isolation policy', () => {
    const catalog = completeRuntimeCatalogFixture();
    validateRuntimeCatalog(catalog);
    expect(selectRuntime('node', 'linux/amd64', catalog).stack).toBe('node');
    const missing = structuredClone(catalog) as any; delete missing.promotion.requalification;
    expect(() => validateRuntimeCatalog(missing)).toThrow('INVALID_RUNTIME_PROMOTION');
    const otherBuild = structuredClone(catalog); otherBuild.promotion!.requalification.buildInputsRevision = 'other-build';
    expect(() => validateRuntimeCatalog(otherBuild)).toThrow('INVALID_RUNTIME_PROMOTION');
    const otherPolicy = structuredClone(catalog); otherPolicy.promotion!.requalification.isolationPolicyHash = 'e'.repeat(64);
    expect(() => selectRuntime('node', 'linux/amd64', otherPolicy)).toThrow('STALE_RUNTIME_QUALIFICATION');
  });

  test('promotion records the staged triggers and refuses ones measured under another isolation policy', () => {
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, [], { ...current, isolationPolicyHash: 'e'.repeat(64) })).toThrow('STALE_RUNTIME_QUALIFICATION');
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, [], { ...current, buildInputsRevision: 'other' })).toThrow('INVALID_REQUALIFICATION_TRIGGERS');
    expect(() => catalogPromotionCandidate(committedCatalog, buildInputs, [], { ...current, extra: true } as any)).toThrow('INVALID_REQUALIFICATION_TRIGGERS');
  });
});
