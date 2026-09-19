export interface S3ObjectInfo {
  objectKey: string;
  size: number;
  etag?: string;
  metadata?: Record<string, string>;
}

/**
 * What one cache tier did during restore. Tiers report failures; orchestrators decide.
 * `transferMs` is the S3 download alone, so a step's metrics can separate it from archiving.
 */
export type RestoreOutcome =
  | { kind: 'hit'; matchedKey: string; exact: boolean; s3?: S3ObjectInfo; transferMs?: number }
  | { kind: 'miss' }
  | { kind: 'error'; error: Error };

/** What one cache tier did during save. `transferMs` is the S3 upload alone. */
export type SaveOutcome =
  | { kind: 'saved'; s3?: S3ObjectInfo; transferMs?: number }
  | { kind: 'exists'; s3?: S3ObjectInfo; transferMs?: number }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: Error };

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
