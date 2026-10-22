/**
 * Workflow action pins (supply chain, free).
 *
 * A tag (`@v7`) or branch ref is mutable: whoever controls the action's
 * repository can repoint it, and the next CI run executes the new code with
 * this repository's token and secrets. Every remote `uses:` in a workflow or
 * composite action must name a full 40-character commit SHA (Dependabot's
 * `github-actions` ecosystem keeps those current, with the tag in a trailing
 * comment), and every `docker://` image must name a sha256 digest. Local
 * actions (`./...`) are part of this checkout and need no pin.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const GITHUB_DIR = path.join(ROOT, '.github');

/** Why a `uses:` reference is not immutable, or null when it is. */
export function pinProblem(uses: string): string | null {
  if (uses.startsWith('./')) return null;
  if (uses.startsWith('docker://')) {
    return /@sha256:[0-9a-f]{64}$/.test(uses) ? null : 'docker image is not pinned to a sha256 digest';
  }
  const at = uses.lastIndexOf('@');
  if (at <= 0) return 'remote action has no ref';
  if (!/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?$/.test(uses.slice(0, at))) return 'unrecognized action reference';
  return /^[0-9a-f]{40}$/.test(uses.slice(at + 1)) ? null : 'ref is not a full 40-character commit SHA';
}

/** Every `uses:` in a workflow (job steps and reusable-workflow jobs) or composite action. */
export function usesReferences(document: any): string[] {
  const refs: string[] = [];
  const steps = (list: any) => {
    for (const step of Array.isArray(list) ? list : []) if (typeof step?.uses === 'string') refs.push(step.uses);
  };
  for (const job of Object.values<any>(document?.jobs ?? {})) {
    if (typeof job?.uses === 'string') refs.push(job.uses);
    steps(job?.steps);
  }
  steps(document?.runs?.steps);
  return refs;
}

function automationFiles(): string[] {
  const files: string[] = [];
  const workflows = path.join(GITHUB_DIR, 'workflows');
  for (const name of fs.readdirSync(workflows).sort()) {
    if (/\.ya?ml$/.test(name)) files.push(path.join(workflows, name));
  }
  const actions = path.join(GITHUB_DIR, 'actions');
  for (const name of fs.existsSync(actions) ? fs.readdirSync(actions).sort() : []) {
    for (const file of ['action.yml', 'action.yaml']) {
      if (fs.existsSync(path.join(actions, name, file))) files.push(path.join(actions, name, file));
    }
  }
  return files;
}

describe('workflow action pins', () => {
  test('the classifier accepts immutable references and rejects mutable ones', () => {
    for (const ok of [
      './.github/actions/restore-deps',
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2',
      'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@f4cfcc01edc9c8b756a9b873b7a623ca674da51e',
      `docker://alpine@sha256:${'a'.repeat(64)}`,
    ]) expect(pinProblem(ok), ok).toBeNull();
    for (const bad of [
      'actions/checkout@v7',
      'actions/checkout@main',
      'actions/checkout@3d3c42e',
      'actions/checkout',
      'google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.3.8',
      'docker://alpine:3.20',
      'docker://alpine',
    ]) expect(pinProblem(bad), bad).not.toBeNull();
  });

  test('every remote action, reusable workflow and docker image is pinned immutably', () => {
    const files = automationFiles();
    const problems: string[] = [];
    let scanned = 0;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      const refs = usesReferences(Bun.YAML.parse(source));
      // A parse that misses `uses:` lines would pass vacuously; count them.
      const lines = source.split('\n').filter((line) => /^\s*(?:-\s+)?uses:\s*\S/.test(line)).length;
      expect(refs.length, `${path.relative(ROOT, file)}: parsed ${refs.length} of ${lines} uses: lines`).toBe(lines);
      scanned += refs.length;
      for (const ref of refs) {
        const problem = pinProblem(ref);
        if (problem) problems.push(`${path.relative(ROOT, file)}: ${ref} (${problem})`);
      }
    }
    expect(files.length).toBeGreaterThan(10);
    expect(scanned).toBeGreaterThan(100);
    expect(problems, 'pin each action to a full commit SHA with the tag in a trailing comment').toEqual([]);
  });

  test('Dependabot keeps the pinned actions current', () => {
    const config = Bun.YAML.parse(fs.readFileSync(path.join(GITHUB_DIR, 'dependabot.yml'), 'utf-8')) as any;
    expect((config.updates ?? []).map((update: any) => update['package-ecosystem'])).toContain('github-actions');
  });

  test('Dependabot holds Playwright minor and major bumps behind the windowsHide patch; patch updates still flow', () => {
    const config = Bun.YAML.parse(fs.readFileSync(path.join(__dirname, '..', '.github', 'dependabot.yml'), 'utf-8')) as any;
    const bun = (config.updates ?? []).find((update: any) => update['package-ecosystem'] === 'bun');
    const ignored = Object.fromEntries((bun?.ignore ?? []).map((rule: any) => [rule['dependency-name'], rule]));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(Object.keys(pkg.patchedDependencies ?? {}).some(key => key.startsWith('playwright-core@'))).toBe(true);
    for (const name of ['playwright', 'playwright-core']) {
      expect(ignored[name]).toEqual({ 'dependency-name': name, 'update-types': ['version-update:semver-minor', 'version-update:semver-major'] });
    }
  });

  test('Dependabot holds the Anthropic SDKs to patch updates; their 0.x breaking releases arrive as semver-minor', () => {
    const config = Bun.YAML.parse(fs.readFileSync(path.join(GITHUB_DIR, 'dependabot.yml'), 'utf-8')) as any;
    const bun = (config.updates ?? []).find((update: any) => update['package-ecosystem'] === 'bun');
    const ignored = Object.fromEntries((bun?.ignore ?? []).map((rule: any) => [rule['dependency-name'], rule]));
    for (const name of ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk']) {
      expect(ignored[name]).toEqual({ 'dependency-name': name, 'update-types': ['version-update:semver-minor', 'version-update:semver-major'] });
    }
  });
});
