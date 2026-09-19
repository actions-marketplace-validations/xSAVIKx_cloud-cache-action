/**
 * Builds the "why did my cache miss?" report: every object the restore lookup would list, the
 * version each carries and the sentence that explains the outcome. It lists, and never downloads
 * or writes anything, so it is safe to run before (or instead of) a restore.
 */

import * as core from '@actions/core';
import { formatSize, isExactKeyMatch } from '../utils/inputUtils';
import type { CacheConfig } from './config';
import { listCandidates, type Candidate, type S3Tier } from './s3Tier';
import { escapeHtml, flush } from './summary';

/** Tiers a restore would consult, in order. */
export type ExplainTier = 's3' | 'github';

export interface ExplainCandidate {
  objectKey: string;
  /** The `${version}` the object carries, or '' when it does not fit the key pattern. */
  version: string;
  sizeBytes: number;
  /** ISO timestamp, or '' when the server did not report one. */
  lastModified: string;
  versionMatches: boolean;
}

export interface ExplainSearch {
  /** The ref this listing was scoped to, or null when caches are not scoped to a ref. */
  ref: string | null;
  key: string;
  /** The exact listing prefix used. */
  prefix: string;
  candidates: ExplainCandidate[];
  /** How many candidates were cut from `candidates` by `maxCandidates`. */
  truncated: number;
}

export interface ExplainReport {
  provider: string;
  bucket: string;
  /** The raw `s3-key-pattern`. */
  pattern: string;
  /** The pattern after placeholder removal, with key, version and filename still symbolic. */
  resolvedPattern: string;
  version: string;
  versionInputs: { paths: string[]; compression: string; crossOs: boolean };
  /** Search order: current ref, PR base, default branch; empty when caches are not ref-scoped. */
  refs: string[];
  primaryKey: string;
  restoreKeys: string[];
  /** Tier order a restore would use. */
  tiers: ExplainTier[];
  /** One entry per (ref, key-or-restore-key) actually searched, in restore order. */
  searches: ExplainSearch[];
  wouldHit?: { objectKey: string; matchedKey: string; exact: boolean; ref: string | null };
  /** Human sentences, in report order. */
  reasons: string[];
}

export type ExplainConfig = Pick<
  CacheConfig,
  | 'primaryKey'
  | 'restoreKeys'
  | 'paths'
  | 'enableCrossOsArchive'
  | 'dualCache'
  | 'useFallback'
  | 'restorePriority'
>;

export interface ExplainOptions {
  /** How many candidates each search shows; the rest are counted in `truncated`. */
  maxCandidates?: number;
}

const DEFAULT_MAX_CANDIDATES = 20;

function toCandidateView(candidate: Candidate): ExplainCandidate {
  return {
    objectKey: candidate.objectKey,
    version: candidate.version ?? '',
    sizeBytes: candidate.size,
    lastModified: candidate.lastModified?.toISOString() ?? '',
    versionMatches: candidate.accepted,
  };
}

function byNewest(a: Candidate, b: Candidate): number {
  return (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0);
}

function resolveTiers(config: ExplainConfig): ExplainTier[] {
  if (config.dualCache) {
    return config.restorePriority === 'github-first' ? ['github', 's3'] : ['s3', 'github'];
  }
  return config.useFallback ? ['s3', 'github'] : ['s3'];
}

/** How a ref reads in a sentence; the empty ref means the pattern has no `${ref}`. */
function refLabel(ref: string): string {
  return ref || 'the unscoped prefix';
}

function count(searched: ExplainSearch): number {
  return searched.candidates.length + searched.truncated;
}

/**
 * One sentence per key prefix that failed: the refs where nothing was listed at all are named
 * together, and every ref that listed objects of another version gets its own sentence, since
 * it needs the count and the version inputs.
 */
function buildReasons(
  report: ExplainReport,
  config: ExplainConfig,
  compression: string,
  hitSearch?: ExplainSearch
): string[] {
  const reasons: string[] = [];
  for (const keyPrefix of [config.primaryKey, ...config.restoreKeys]) {
    const searches = report.searches.filter(
      (searched) => searched.key === keyPrefix && searched !== hitSearch
    );
    const empty = searches.filter((searched) => count(searched) === 0);
    if (empty.length > 0) {
      const refs = empty.map((searched) => refLabel(searched.ref ?? '')).join(', ');
      reasons.push(`No objects match key prefix "${keyPrefix}" on ${refs}.`);
    }
    for (const searched of searches.filter((one) => count(one) > 0)) {
      const total = count(searched);
      reasons.push(
        `${total} object${total === 1 ? '' : 's'} match key prefix "${keyPrefix}" on ` +
          `${refLabel(searched.ref ?? '')} but none has version ${report.version} ` +
          `(this job hashes paths ${config.paths.join(', ')} with ${compression}; they were ` +
          `saved with different paths, compression or cross-OS setting).`
      );
    }
  }
  if (report.wouldHit) {
    reasons.push(
      `Would restore ${report.wouldHit.objectKey} (key "${report.wouldHit.matchedKey}", ` +
        `${report.wouldHit.ref ?? 'unscoped'}).`
    );
  }
  return reasons;
}

/**
 * Lists every candidate the restore lookup would consider, in the same order, and stops at the
 * first search that would hit — exactly where the restore would stop. No exact-key HEAD check is
 * needed: the listing under the primary key's prefix already contains the exact object.
 */
export async function buildExplainReport(
  tier: S3Tier,
  config: ExplainConfig,
  options: ExplainOptions = {}
): Promise<ExplainReport> {
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const report: ExplainReport = {
    provider: tier.storage.providerConfig.provider,
    bucket: tier.storage.bucket,
    pattern: tier.template.pattern,
    resolvedPattern: tier.template.resolvedPattern,
    version: tier.template.version,
    versionInputs: {
      paths: [...config.paths],
      compression: tier.compression.method,
      crossOs: config.enableCrossOsArchive,
    },
    refs: tier.restoreRefs.filter((ref) => ref !== ''),
    primaryKey: config.primaryKey,
    restoreKeys: [...config.restoreKeys],
    tiers: resolveTiers(config),
    searches: [],
    reasons: [],
  };

  let hitSearch: ExplainSearch | undefined;
  for (const ref of tier.restoreRefs) {
    for (const keyPrefix of [config.primaryKey, ...config.restoreKeys]) {
      const all = await listCandidates(tier, ref, keyPrefix);
      const shown = all.slice(0, maxCandidates);
      const searched: ExplainSearch = {
        ref: ref || null,
        key: keyPrefix,
        prefix: tier.template.searchPrefix(ref, keyPrefix),
        candidates: shown.map(toCandidateView),
        truncated: all.length - shown.length,
      };
      report.searches.push(searched);

      const accepted = all.filter((candidate) => candidate.accepted).sort(byNewest);
      if (accepted.length > 0) {
        const matchedKey = accepted[0].key as string;
        report.wouldHit = {
          objectKey: accepted[0].objectKey,
          matchedKey,
          exact: isExactKeyMatch(config.primaryKey, matchedKey),
          ref: ref || null,
        };
        hitSearch = searched;
        break;
      }
    }
    if (hitSearch) {
      break;
    }
  }

  report.reasons = buildReasons(report, config, tier.compression.method, hitSearch);
  return report;
}

/** The report as log lines, in the order a reader wants them. */
export function renderExplain(report: ExplainReport): string[] {
  const lines = [
    `Cache lookup for key "${report.primaryKey}"`,
    `Pattern: ${report.pattern} → ${report.resolvedPattern}`,
    `Version: ${report.version} (paths: ${report.versionInputs.paths.join(', ')}; ` +
      `compression: ${report.versionInputs.compression}; cross-OS: ${report.versionInputs.crossOs})`,
    report.refs.length > 0 ? `Refs searched: ${report.refs.join(' → ')}` : 'Not scoped to a ref',
    `Tiers: ${report.tiers.join(' → ')}`,
  ];
  if (report.restoreKeys.length > 0) {
    lines.push(`Restore keys: ${report.restoreKeys.join(', ')}`);
  }
  for (const searched of report.searches) {
    const total = count(searched);
    lines.push(
      `[${searched.ref ?? 'unscoped'}] prefix "${searched.prefix}": ` +
        `${total} candidate${total === 1 ? '' : 's'}`
    );
    for (const candidate of searched.candidates) {
      lines.push(
        `  ${candidate.versionMatches ? '✓' : '✗'} ${candidate.objectKey} ` +
          `(version ${candidate.version || 'unknown'}, ${formatSize(candidate.sizeBytes)}, ` +
          `${candidate.lastModified || 'unknown'})`
      );
    }
    if (searched.truncated > 0) {
      lines.push(`  … and ${searched.truncated} more not shown`);
    }
  }
  for (const reason of report.reasons) {
    lines.push(`Result: ${reason}`);
  }
  return lines;
}

/** Adds the rendered report to the job summary, when the job-summary input allows it. */
export async function writeExplainSummary(
  report: ExplainReport,
  jobSummary: boolean
): Promise<void> {
  if (!jobSummary || !process.env.GITHUB_STEP_SUMMARY) {
    return;
  }
  core.summary
    .addHeading('Cache lookup explained')
    .addRaw(`<pre>${renderExplain(report).map(escapeHtml).join('\n')}</pre>`, true);
  await flush();
}
