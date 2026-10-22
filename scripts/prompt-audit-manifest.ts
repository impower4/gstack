#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * Prompt-audit manifest: the files a contributor feeds to Anthropic's
 * `/claude-api prompt-audit` (a Claude Code skill, run in your own Claude Code
 * session) at each frontier-model release, cut into slices small enough for
 * one audit pass each. Procedure: CONTRIBUTING.md "Prompt audit at each
 * frontier-model release".
 *
 * Slices, in order: shared instructions every skill reads (CLAUDE.md, model
 * overlays, preamble resolvers), the other resolvers, the skill templates
 * (a skill's SKILL.md.tmpl and sections stay in one slice), the code that
 * builds model requests, and the tests that pin skill wording (they read a
 * template, skill or resolver and assert a literal of 40+ characters).
 *
 * Usage: bun run audit:manifest [--json] [--budget-kb <n>]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DEFAULT_BUDGET_KB = 200;

export interface AuditSlice { id: string; group: string; files: string[]; bytes: number }

function walk(dir: string, keep: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      const rel = relative(ROOT, p).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') visit(p);
      } else if (keep(rel)) {
        out.push(rel);
      }
    }
  };
  visit(dir);
  return out.sort();
}

const size = (rel: string) => statSync(join(ROOT, rel)).size;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Pack units (each a list of files that must stay together) into slices under the budget. */
function pack(group: string, units: string[][], budget: number): Omit<AuditSlice, 'id'>[] {
  const slices: Omit<AuditSlice, 'id'>[] = [];
  let current: Omit<AuditSlice, 'id'> | null = null;
  for (const unit of units) {
    const bytes = unit.reduce((sum, f) => sum + size(f), 0);
    if (!current || (current.bytes > 0 && current.bytes + bytes > budget)) {
      current = { group, files: [], bytes: 0 };
      slices.push(current);
    }
    current.files.push(...unit);
    current.bytes += bytes;
  }
  return slices;
}

export function buildManifest(budgetKb = DEFAULT_BUDGET_KB): AuditSlice[] {
  const budget = budgetKb * 1024;
  const preamble = walk(join(ROOT, 'scripts/resolvers/preamble'), rel => rel.endsWith('.ts'));
  const shared = ['CLAUDE.md', ...walk(join(ROOT, 'model-overlays'), rel => rel.endsWith('.md')), ...preamble];
  const resolvers = walk(join(ROOT, 'scripts/resolvers'), rel => rel.endsWith('.ts') && !preamble.includes(rel));

  const templates = walk(ROOT, rel => rel.endsWith('.tmpl') && !rel.startsWith('test/'));
  const bySkill = new Map<string, string[]>();
  for (const rel of templates) {
    const skill = rel.includes('/') ? rel.split('/')[0] : '(root)';
    bySkill.set(skill, [...(bySkill.get(skill) ?? []), rel]);
  }

  const requestCode = [...walk(join(ROOT, 'lib'), rel => rel.endsWith('.ts')),
    ...walk(join(ROOT, 'design/src'), rel => rel.endsWith('.ts')),
    ...walk(join(ROOT, 'test/helpers'), rel => rel.endsWith('.ts'))]
    .filter(rel => /api\.anthropic\.com|api\.openai\.com|\/v1\/messages|messages\.create|responses\.create/.test(read(rel)));

  const pinningTests = walk(join(ROOT, 'test'), rel => /^test\/[^/]+\.test\.ts$/.test(rel))
    .filter(rel => {
      const src = read(rel);
      return /SKILL\.md|\.md\.tmpl|scripts\/resolvers|model-overlays/.test(src) && /\.(toContain|toMatch)\((['"`])[^'"`]{40,}/.test(src);
    });

  const slices = [
    ...pack('shared instructions', [shared], Infinity),
    ...pack('resolvers', resolvers.map(f => [f]), budget),
    ...pack('skill templates', [...bySkill.values()], budget),
    ...pack('model-request code', requestCode.map(f => [f]), budget),
    ...pack('tests that pin skill wording', pinningTests.map(f => [f]), budget),
  ];
  return slices.map((slice, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, ...slice }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const budgetArg = args.indexOf('--budget-kb');
  const budgetKb = budgetArg >= 0 ? Number(args[budgetArg + 1]) : DEFAULT_BUDGET_KB;
  if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
    console.error('--budget-kb needs a positive number of kilobytes');
    process.exit(2);
  }
  const manifest = buildManifest(budgetKb);
  if (args.includes('--json')) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    const files = manifest.reduce((n, s) => n + s.files.length, 0);
    console.log(`Prompt-audit manifest: ${manifest.length} slices, ${files} files. Run /claude-api prompt-audit in Claude Code on one slice at a time (CONTRIBUTING.md).`);
    for (const slice of manifest) {
      console.log(`\n## ${slice.id} ${slice.group} (${slice.files.length} files, ${Math.round(slice.bytes / 1024)} KB)`);
      for (const file of slice.files) console.log(file);
    }
  }
}
