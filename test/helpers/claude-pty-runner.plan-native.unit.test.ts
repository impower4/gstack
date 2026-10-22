/**
 * Deterministic unit tests for native plan terminal/report checks (test/helpers/pty/plan-native.ts).
 * Split along the W4 module seams from the former claude-pty-runner.unit.test.ts;
 * tests import the public barrel, test/helpers/claude-pty-runner.ts.
 */
import { describe, test, expect } from 'bun:test';
import {
  assertReviewReportAtBottom,
} from './claude-pty-runner';

describe('assertReviewReportAtBottom', () => {
  test('passes when REVIEW REPORT is the only/last ## heading', () => {
    const content = `# Plan

## Context
stuff

## Approach
more stuff

## GSTACK REVIEW REPORT

| col | col |
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(true);
  });

  test('fails when REVIEW REPORT is missing', () => {
    const content = `# Plan

## Context
stuff
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no GSTACK REVIEW REPORT/);
  });

  test('fails when REVIEW REPORT exists but a ## heading follows it', () => {
    const content = `# Plan

## GSTACK REVIEW REPORT

| col | col |

## Late Section
oops
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/trailing ## heading/);
    expect(r.trailingHeadings).toEqual(['## Late Section']);
  });

  test('passes when only ### subheadings follow REVIEW REPORT (deeper nesting allowed)', () => {
    const content = `## GSTACK REVIEW REPORT

### Cross-model tension
- F1: resolved
- F2: resolved
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(true);
  });

  test('fails with multiple trailing ## headings reported', () => {
    const content = `## GSTACK REVIEW REPORT

## First trailing

## Second trailing
`;
    const r = assertReviewReportAtBottom(content);
    expect(r.ok).toBe(false);
    expect(r.trailingHeadings).toHaveLength(2);
  });
});
