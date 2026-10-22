import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..', '..');

export interface ShippedSkillRouting {
  /** The whole `## Skill routing` section gstack offers to append to CLAUDE.md. */
  section: string;
  /** The heading plus the opening instruction, without the per-skill rules. */
  instruction: string;
  /** The `- request → invoke /skill` rule lines. */
  rules: string[];
}

/**
 * Read the routing section from the routing-injection heredoc in
 * bin/gstack-skill-start, so E2E fixtures use the routing text users receive.
 */
export function readShippedSkillRouting(root = ROOT): ShippedSkillRouting {
  const source = fs.readFileSync(path.join(root, 'bin', 'gstack-skill-start'), 'utf8');
  const heredoc = source.match(/<<'EOI' \| _emit_block routing-injection\n([\s\S]*?)\nEOI\n/)?.[1];
  if (!heredoc) throw new Error('bin/gstack-skill-start: routing-injection heredoc not found');
  const start = heredoc.search(/^## Skill routing$/m);
  const end = heredoc.search(/^If B:/m);
  if (start < 0 || end < start) throw new Error('bin/gstack-skill-start: ## Skill routing section not found');
  const section = heredoc.slice(start, end).trim();
  const rules = section.split('\n').filter(line => /^- .+→ invoke \//.test(line));
  const instruction = section.split(/\n\n/).slice(0, 2).join('\n\n');
  if (rules.length === 0 || !/Skill tool/.test(instruction)) {
    throw new Error('bin/gstack-skill-start: ## Skill routing section has an unexpected shape');
  }
  return { section, instruction, rules };
}
