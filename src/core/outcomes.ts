export interface S3ObjectInfo {
  objectKey: string;
  size: number;
  etag?: string;
  metadata?: Record<string, string>;
}

/** What one cache tier did during restore. Tiers report failures; orchestrators decide. */
export type RestoreOutcome =
  | { kind: 'hit'; matchedKey: string; exact: boolean; s3?: S3ObjectInfo }
  | { kind: 'miss' }
  | { kind: 'error'; error: Error };

/** What one cache tier did during save. */
export type SaveOutcome =
  | { kind: 'saved'; s3?: S3ObjectInfo }
  | { kind: 'exists'; s3?: S3ObjectInfo }
  | { kind: 'skipped'; reason: string }
  | { kind: 'error'; error: Error };

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
