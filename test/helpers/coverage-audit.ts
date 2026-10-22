import { isDeepStrictEqual } from 'node:util';
import * as path from 'node:path';
import type { SkillTestResult } from './session-runner';
import { coverageAuditReadEvidence } from './coverage-audit-evidence';

export interface CoverageFile { path: string; content: string }

/** Require both nonce-bearing fixtures in successful, owned native tool output.
 * coverageAuditReadEvidence is the single owner of what counts as a read: a
 * native Read of the path, or a closed read-only Bash command whose cat/sed
 * output holds the complete file at its own position. A command, assistant
 * claim, pending call or echoed copy is no proof.
 */
export function requireCoverageFileReads(transcript: any[], cwd: string, files: CoverageFile[]): void {
  // A retained transcript keeps the originating filesystem's path namespace.
  const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd) ? path.win32 : path.posix;
  const required = ['src/billing.ts', 'test/billing.test.ts'].map(file => paths.join(cwd, file));
  if (!isDeepStrictEqual(files.map(file => file.path).sort(), [...required].sort())
    || files.some(file => typeof file.content !== 'string' || !file.content.trim())) {
    throw new Error('Coverage audit: source and test expectations are required');
  }
  const [source, tests] = required.map(file => files.find(candidate => candidate.path === file)!);
  const reads = coverageAuditReadEvidence(Array.isArray(transcript) ? transcript : [], { cwd, source: source!, tests: tests! });
  const missing = [[reads.sourceRead, source!], [reads.testsRead, tests!] as const]
    .filter(([read]) => !read).map(([, file]) => paths.relative(cwd, (file as CoverageFile).path));
  if (missing.length) throw new Error(`Coverage audit: no successful complete file read: ${missing.join(', ')}`);
}

export function validateCoverageAudit(result: SkillTestResult, cwd: string, files: CoverageFile[]): void {
  if (result.exitReason !== 'success') throw new Error(`Coverage audit process: ${result.exitReason}`);
  if (result.browseErrors.length) throw new Error('Coverage audit reported browser errors');
  const output = result.output || '';
  const lower = output.toLowerCase();
  const hasGap = lower.includes('gap') || lower.includes('no test');
  const hasTested = /\btested\b/i.test(output) || output.includes('✓') || output.includes('★');
  const hasCoverage = lower.includes('coverage') || lower.includes('paths tested');
  if (!hasGap || !hasTested || !hasCoverage || !output.includes('processPayment') || !output.includes('refundPayment')) {
    throw new Error('Coverage audit: diagram must name both functions and show tested paths, gaps and coverage');
  }
  requireCoverageFileReads(result.transcript, cwd, files);
}
