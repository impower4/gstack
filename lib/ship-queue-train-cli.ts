/**
 * Argument parsing and output for the merge-train surface of
 * bin/gstack-ship-queue: `train build|status|verdict|bisect|rebuild|prune`,
 * `ready --screen|--no-screen [--broad]` and `verify --train`. Every command
 * prints its lines, the coded error line on stderr, then `NEXT: <command>`
 * and the canonical `GSTACK_RESULT: skill=ship-queue status=<s> run=<record>`.
 * Loaded by the bin only when one of those paths runs.
 */
import { EXIT, formatResult } from './headless-artifacts';
import { RESULT_CODES } from './result-codes';
import type { QueueContext } from './ship-queue';
import { buildTrain, pruneTrains, trainStatus, type TrainOut } from './ship-queue-train';
import { trainReady } from './ship-queue-train-ready';
import { trainBisect, trainRebuild, trainVerdict } from './ship-queue-train-verdict';
import { verifyTrain } from './ship-queue-train-verify';
import { redactCause } from './ship-queue-train-record';

export const TRAIN_HELP = `  train build --prs <n>@<sha>[,...] [--urgent | --repair] [--dry-run] [--free-timeout <s>]
  train build --train <nonce>              resume a train (push, free tests, dispatch) from its record
                                           merge pinned unstamped heads in slot order onto main, free tests on
                                           train/<nonce>, then one full gate through eval-bg's nonce
  train status [--train <nonce>]           never spends: rebuild records from refs/notes/gstack-trains, reconcile
                                           unconfirmed dispatches by nonce
  train verdict --train <nonce>            read the gate run and its record: GREEN, RED, INCOMPLETE or PENDING
  train bisect --train <nonce> --spend-cap <usd> [--dry-run]
                                           red cases on every prefix T0..Tk, resumable and capped
  train rebuild --train <nonce> [--infra]  the one rebuild an all-green bisect earns (or the one INFRA re-dispatch)
  train prune [--train <nonce>] [--dry-run]
                                           delete train/<nonce> branches of merged, superseded or dropped trains
  ready --pr <n> --screen [--broad] | --no-screen [--dry-run]
                                           (train policy) READY plus the screen choice, recorded as a receipt
  verify --pr <n> --train <nonce> [--no-fetch]
                                           (train policy) the merge check against a green train record
  Merge trains need a "train" block in the base revision's ship policy (docs/ship-policy.md#run-a-merge-train).`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function printTrain(cmd: string, out: TrainOut): number {
  for (const line of out.lines) process.stdout.write(line + '\n');
  if (out.failure) {
    const f = out.failure;
    process.stderr.write(`gstack-ship-queue ${cmd}: ${f.message}; fix: ${f.fix ?? RESULT_CODES[f.code].fix} (${f.code})\n`);
  }
  process.stdout.write(`NEXT: ${out.next}\n`);
  process.stdout.write(formatResult('ship-queue', out.status, out.run) + '\n');
  return out.exit;
}

function usage(message: string): number {
  process.stderr.write(`gstack-ship-queue: ${message}\n${TRAIN_HELP}\n`);
  return EXIT.usage;
}

async function guarded(cmd: string, fn: () => Promise<TrainOut> | TrainOut): Promise<number> {
  try {
    return printTrain(cmd, await fn());
  } catch (error) {
    const cause = redactCause(error instanceof Error ? error.message : String(error));
    process.stderr.write(`gstack-ship-queue ${cmd}: unexpected failure: ${cause}\n`);
    process.stdout.write(`NEXT: gstack-ship-queue train status\n`);
    process.stdout.write(formatResult('ship-queue', 'interrupted', 'none') + '\n');
    return EXIT.fail;
  }
}

const positive = (s: string | undefined, fallback: number) => (s !== undefined && /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 ? Number(s) : s === undefined ? fallback : NaN);

export async function trainMain(ctx: QueueContext, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const nonce = flag(rest, '--train');
  const dryRun = rest.includes('--dry-run');
  if (sub === 'build') {
    if (!nonce && !flag(rest, '--prs')) return usage('train build needs --prs <n>@<sha>[,...] or --train <nonce>');
    const freeTimeoutSec = positive(flag(rest, '--free-timeout'), 2700);
    if (Number.isNaN(freeTimeoutSec)) return usage('--free-timeout needs seconds');
    if (rest.includes('--urgent') && rest.includes('--repair')) return usage('--urgent and --repair are separate one-PR trains; pass one');
    return guarded('train build', () => buildTrain(ctx, {
      pins: flag(rest, '--prs'), resume: nonce, dryRun, urgent: rest.includes('--urgent'), repair: rest.includes('--repair'), freeTimeoutSec,
      pollMs: Number(process.env.GSTACK_SHIP_QUEUE_POLL_MS) || 30_000,
    }));
  }
  if (sub === 'status') return guarded('train status', () => trainStatus(ctx, { train: nonce }));
  if (sub === 'prune') return guarded('train prune', () => pruneTrains(ctx, { dryRun, train: nonce }));
  if (!nonce) return usage(`train ${sub ?? '<subcommand>'} needs --train <nonce>`);
  if (sub === 'verdict') return guarded('train verdict', () => trainVerdict(ctx, { train: nonce }));
  if (sub === 'rebuild') return guarded('train rebuild', () => trainRebuild(ctx, { train: nonce, infra: rest.includes('--infra') }));
  if (sub === 'bisect') {
    const cap = positive(flag(rest, '--spend-cap'), NaN);
    if (Number.isNaN(cap)) return usage('train bisect needs --spend-cap <usd>');
    return guarded('train bisect', () => trainBisect(ctx, { train: nonce, spendCap: cap, dryRun }));
  }
  return usage(`unknown train subcommand ${sub}`);
}

export async function readyMain(ctx: QueueContext, args: string[], base: { pr: string; pregate?: string; gateExit?: number; gateLog?: string }): Promise<number> {
  const screen = args.includes('--screen');
  const noScreen = args.includes('--no-screen');
  if (screen && noScreen) return usage('pass one of --screen or --no-screen');
  if (args.includes('--broad') && !screen) return usage('--broad selects the screen policy; it needs --screen');
  return guarded('ready', () => trainReady(ctx, { ...base, screen: screen ? 'screen' : noScreen ? 'no-screen' : undefined, broad: args.includes('--broad'), dryRun: args.includes('--dry-run') }));
}

export async function verifyMain(ctx: QueueContext, args: string[], pr: string): Promise<number> {
  return guarded('verify', () => verifyTrain(ctx, { pr, train: flag(args, '--train')!, noFetch: args.includes('--no-fetch') }));
}
