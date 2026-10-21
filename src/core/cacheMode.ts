/**
 * The runner exports ACTIONS_CACHE_MODE to tell a job what it may do with a cache. @actions/cache
 * 6.2.0 reads it for the GitHub tier. These functions copy its parsing (internal/config.js), so
 * the S3 tier obeys the same value in the same way.
 */

/** The cache-mode lattice: readable = {read, write}, writable = {write, write-only}. */
const KNOWN_CACHE_MODES = ['none', 'read', 'write', 'write-only'];

/** The effective cache mode, trimmed and in lower case, or '' when the variable is not set. */
export function getCacheMode(env: NodeJS.ProcessEnv = process.env): string {
  return (env.ACTIONS_CACHE_MODE || '').trim().toLowerCase();
}

/** An unset or unknown mode permits reads, as in @actions/cache. */
export function isCacheReadable(mode: string): boolean {
  if (!KNOWN_CACHE_MODES.includes(mode)) {
    return true;
  }
  return mode === 'read' || mode === 'write';
}

/** An unset or unknown mode permits writes, as in @actions/cache. */
export function isCacheWritable(mode: string): boolean {
  if (!KNOWN_CACHE_MODES.includes(mode)) {
    return true;
  }
  return mode === 'write' || mode === 'write-only';
}
