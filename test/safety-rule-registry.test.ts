/**
 * E3 safety-rule registry: every held safety rule stays tied to the paid eval
 * that measures it. A rule's text cannot change without its hash being
 * updated in the same rewording commit, and its eval cannot be removed while
 * the rule remains. Quarantined evals still count as present.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { E2E_KINDS, E2E_TIERS, E2E_TOUCHFILES } from './helpers/touchfiles-data';
import { matchGlob } from './helpers/test-selection';
import { SAFETY_RULES, locateRule, normalizeRuleText, removeRule, ruleHash } from './helpers/safety-rules';
import { outsideVoiceCommand } from '../scripts/resolvers/outside-voice';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const REGISTRY = 'test/helpers/safety-rules.ts';

describe('safety-rule registry', () => {
  for (const rule of SAFETY_RULES) {
    test(`${rule.id}: rule located in ${rule.source}`, () => {
      const text = fs.readFileSync(path.join(ROOT, rule.source), 'utf8');
      const hit = locateRule(text, rule);
      if (!hit) {
        throw new Error(`${rule.id}: anchor ${rule.match} not found in ${rule.source}${rule.section ? ` under "${rule.section}"` : ''}. `
          + `If the rule was deleted, remove its row from ${REGISTRY} and retire its eval ${rule.evalId}; `
          + `if it moved, update the anchor in ${REGISTRY} in the same commit.`);
      }
      const current = ruleHash(hit.paragraph);
      if (current !== rule.sha256) {
        throw new Error(`${rule.id}: rule text changed in ${rule.source} (anchor ${rule.match}).\n`
          + `  old hash: ${rule.sha256}\n  new hash: ${current}\n  eval: ${rule.evalId}\n`
          + `A rewording lands only after ${rule.evalId} discriminates and its "after" runs are clean on every render that carries the rule. `
          + `Then update the hash in ${REGISTRY} in the rewording commit.`);
      }
    });

    test(`${rule.id}: eval ${rule.evalId} is registered`, () => {
      const missing = [
        !(rule.evalId in E2E_TOUCHFILES) && 'E2E_TOUCHFILES',
        !(rule.evalId in E2E_TIERS) && 'E2E_TIERS',
        !(rule.evalId in E2E_KINDS) && 'E2E_KINDS',
      ].filter(Boolean);
      if (missing.length) {
        throw new Error(`${rule.id}: eval ${rule.evalId} is missing from ${missing.join(', ')} (test/helpers/touchfiles-data.ts) `
          + `while its rule remains in ${rule.source}. Restore the eval, or remove the rule and its row in ${REGISTRY} together.`);
      }
      const covered = E2E_TOUCHFILES[rule.evalId]!.some(pattern => matchGlob(rule.source, pattern));
      if (!covered) throw new Error(`${rule.id}: E2E_TOUCHFILES['${rule.evalId}'] does not cover ${rule.source}, so a rewording would not select its eval. Add the source to that entry.`);
    });
  }

  test('anchors are unique and rule-removed arms delete exactly the rule', () => {
    expect(new Set(SAFETY_RULES.map(r => r.id)).size).toBe(SAFETY_RULES.length);
    expect(new Set(SAFETY_RULES.map(r => r.evalId)).size).toBe(SAFETY_RULES.length);
    for (const rule of SAFETY_RULES) {
      const text = fs.readFileSync(path.join(ROOT, rule.source), 'utf8');
      const removed = removeRule(text, rule);
      const hit = locateRule(text, rule)!;
      expect(removed.length).toBeLessThan(text.length);
      expect(normalizeRuleText(removed)).not.toContain(normalizeRuleText(hit.paragraph));
    }
  });
});

describe('codex-host outside reviewer stays tool-less', () => {
  test('no outside-voice resolver grants read-only access to gstack-claude-code', () => {
    const dir = path.join(ROOT, 'scripts', 'resolvers');
    const offenders = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter(file => file.endsWith('.ts'))
      .filter(file => /access\s*:\s*['"`]read-only['"`]/.test(fs.readFileSync(path.join(dir, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('the codex-host dispatch runs Claude Code with --access none', () => {
    const ctx: TemplateContext = { skillName: 'review', tmplPath: 'review/SKILL.md.tmpl', host: 'codex', paths: HOST_PATHS.codex };
    const command = outsideVoiceCommand(ctx, { timeoutMs: 1000 });
    expect(command).toContain('gstack-claude-code');
    expect(command).toContain('--access none');
    expect(command).not.toContain('--access read-only');
  });
});
