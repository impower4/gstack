import { createHash } from 'node:crypto';

export type ProducerHost = 'claude' | 'codex' | 'gemini';
export type ProducerVersion = 'v2' | 'v3';
export type ProducerMode = 'daily' | 'comprehensive';
export type ProducerStack = 'node' | 'bun' | 'python' | 'rails';
export type ProducerVariant = 'vulnerable' | 'fixed';
export type ProducerPlatform = 'linux/amd64' | 'linux/arm64';
export const PRODUCER_PLATFORMS: readonly ProducerPlatform[] = ['linux/amd64', 'linux/arm64'];

export interface ProducerCell {
  id: string;
  caseId: string;
  stack: ProducerStack;
  variant: ProducerVariant;
  version: ProducerVersion;
  mode: ProducerMode;
  repetition: 1 | 2 | 3;
  model: string;
  host: ProducerHost;
  budgetSeconds: number;
  sourceHash: string;
  skillHash: string;
  /** Release and baseline cells pin the native producer platform; full-profile cells omit it. */
  platform?: ProducerPlatform;
}

export interface ProducerSourceEntry {
  path: string;
  sha256: string;
  bytes: number;
}

/**
 * Only what a producer needs to run one cell. It never names the corpus case,
 * variant, version, or repetition: an agent that can read its own control file
 * or receipt still cannot tell which answer it is being graded against.
 */
export interface ProducerExecution {
  mode: ProducerMode;
  model: string;
  host: ProducerHost;
  budgetSeconds: number;
  sourceHash: string;
  skillHash: string;
  platform?: ProducerPlatform;
}

/**
 * This control file is consumed before a producing agent starts. It must never
 * be placed inside the application repository or retained on the producer.
 */
export interface ProducerInput {
  schemaVersion: 2;
  /** The opaque matrix cell id; only the trusted evaluator maps it back to a cell. */
  cellRef: string;
  /** Exact canonical portable payload: root SKILL.md plus its manifest-listed sections. */
  skill: string;
  source: ProducerSourceEntry[];
  execution: ProducerExecution;
}

export function producerExecution(cell: ProducerCell): ProducerExecution {
  return {
    mode: cell.mode, model: cell.model, host: cell.host, budgetSeconds: cell.budgetSeconds,
    sourceHash: cell.sourceHash, skillHash: cell.skillHash, ...(cell.platform === undefined ? {} : { platform: cell.platform }),
  };
}

export interface ProducerArtifactIdentity {
  sha256: string;
  bytes: number;
}

export interface ProducerInstallationIdentity {
  schemaVersion: 1;
  producer: ProducerArtifactIdentity;
  launcher: ProducerArtifactIdentity;
  core: ProducerArtifactIdentity;
  watchdog: ProducerArtifactIdentity;
  /** The adjacent manifest is exactly `<coreSha256>\n`; bind both its bytes and declaration. */
  generation: {
    coreSha256: string;
    manifest: ProducerArtifactIdentity;
  };
  embeddedCatalogs: {
    runtimeRevision: string;
    runtimeBuildRevision: string;
    runtimeSha256: string;
    scannerRevision: string;
    scannerSha256: string;
  };
  identityHash: string;
}

export interface ProducerProviderIdentity {
  schemaVersion: 1;
  family: 'claude' | 'gpt' | 'gemini';
  policyRevision: string;
  executable: ProducerArtifactIdentity;
  argsPrefix: string[];
  version: string;
  identityHash: string;
}

export interface ProducerArtifactInventory {
  schemaVersion: 1;
  root: 'security/cso';
  /** Sorted safe paths relative to root within the retained helper home. */
  entries: ProducerSourceEntry[];
  totalBytes: number;
  identityHash: string;
}

export interface ProducerReceipt {
  schemaVersion: 2;
  /** The opaque cell id from the consumed input; bound together with inputHash. */
  cellRef: string;
  inputHash: string;
  installationIdentity: ProducerInstallationIdentity;
  providerIdentity: ProducerProviderIdentity;
  artifacts: ProducerArtifactInventory;
  startedAt: string;
  finishedAt: string;
  status: 'succeeded' | 'failed';
  requestedModel: string;
  modelUsed: string;
  /** Provider-reported when it differs; otherwise the exact CLI model pin. */
  modelIdentitySource: 'provider_reported' | 'requested_pin';
  durationMs: number;
  firstUsefulResultMs: null;
  toolCalls: number;
  /** Content-free tool timeline (name, offset, thread) for diagnosing overruns; absent when the adapter has none. */
  toolTimeline?: Array<{ atMs: number; endMs?: number; tool: string; agent: 'main' | 'subagent' }>;
  output: string;
  outputHash: string;
  usage: {
    /** CLI/provider-reported tokens. Null means the adapter did not report usage. */
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    /** Pricing-table estimate, not a host-billed amount. */
    estimatedCostUSD: number | null;
  };
  error?: { code: string; reason: string };
  receiptHash: string;
}

/**
 * Compact trusted index; raw output remains in the separately retained receipt.
 * Collection adds the matrix cell that the receipt's cellRef names.
 */
export type ProducerReceiptIndex = Omit<ProducerReceipt, 'output' | 'error' | 'toolTimeline'> & {
  cell: ProducerCell;
  error?: { code: string };
};

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

/** The native platform this producer process runs on, or null when no CSO runtime platform matches it. */
export function producerHostPlatform(platform: string = process.platform, arch: string = process.arch): ProducerPlatform | null {
  if (platform !== 'linux') return null;
  return arch === 'x64' ? 'linux/amd64' : arch === 'arm64' ? 'linux/arm64' : null;
}

export function producerInputHash(input: ProducerInput): string {
  return sha256(JSON.stringify(input));
}

export function producerReceiptHash(receipt: Omit<ProducerReceipt, 'receiptHash'>): string {
  return sha256(JSON.stringify(receipt));
}

export function producerInstallationIdentityHash(identity: Omit<ProducerInstallationIdentity, 'identityHash'>): string {
  if (!identity.generation || !identity.generation.manifest || identity.generation.coreSha256 !== identity.core.sha256 ||
      identity.generation.manifest.bytes !== 65 ||
      identity.generation.manifest.sha256 !== sha256(`${identity.generation.coreSha256}\n`)) {
    throw new Error('INVALID_PRODUCER_GENERATION_IDENTITY');
  }
  return sha256(JSON.stringify(identity));
}

export function producerProviderIdentityHash(identity: Omit<ProducerProviderIdentity, 'identityHash'>): string {
  return sha256(JSON.stringify(identity));
}

export function producerArtifactInventoryHash(inventory: Omit<ProducerArtifactInventory, 'identityHash'>): string {
  return sha256(JSON.stringify(inventory));
}
