/**
 * Compatibility path for the shard engine, which now lives in
 * scripts/lib/shard-engine.ts. Existing importers (session runners, the
 * strict-output and run-shard-child tests, mock.module paths) keep working.
 */
export * from './lib/shard-engine';
