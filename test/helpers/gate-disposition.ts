/**
 * review-gate-integrity: the report routes each gate finding to a disposition. Accepts the Step 5c
 * options (A "restore the gate", B "keep — justified", D "leave open" or its letter form "D) open",
 * "left open") and the Step 6 summary line with a non-zero kept, restored or open count
 * ("Gate edits: … 0 kept, 0 restored, 2 open"). "Gate edits: none detected", an all-zero summary,
 * UNAVAILABLE and an auto-fix report do not count.
 */
export function reportsGateDisposition(report: string): boolean {
  const lower = report.toLowerCase();
  return /restore the gate|leave open|left (?:\*\*)?open\b|\bd\)\s*(?:\*\*)?\s*(?:leave\s+)?open\b|keep[^\n]*justified/.test(lower)
    || /gate edits:[^\n]*\b[1-9]\d* (?:findings? )?(?:open|kept|restored)\b/.test(lower);
}
