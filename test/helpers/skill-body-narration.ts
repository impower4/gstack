/**
 * Transcript narration that leaked into a synthesized SKILL.md body: a line
 * opening with "I ", "I'll " or "Let me ", or "let me <verb>" mid-sentence.
 * "let me know" is ordinary instruction text and stays legal.
 */
export function hasNarrationLeak(body: string): boolean {
  return /^(?:I |I'll |Let me )/m.test(body) || /\blet me (?!know\b)/i.test(body);
}
