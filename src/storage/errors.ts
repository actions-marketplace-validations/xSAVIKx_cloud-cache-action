/**
 * S3 also answers 403 when the credentials themselves are wrong: a bad key, a bad signature, a
 * clock skew or an expired session token. Those errors are not a missing write permission, so a
 * hint about read-only would mislead.
 */
const CREDENTIAL_ERROR_NAMES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'RequestTimeTooSkewed',
  'ExpiredToken',
  'InvalidToken',
  'TokenRefreshRequired',
]);

/**
 * True when S3 refused the request because the credentials do not have the permission: the error
 * name `AccessDenied`, or an HTTP 403 that is not a credential error. The check follows the
 * `cause` chain, because some callers wrap the SDK error.
 */
export function isAccessDeniedError(err: unknown): boolean {
  for (let current = err, depth = 0; depth < 5; depth++) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }
    const error = current as {
      name?: string;
      cause?: unknown;
      $metadata?: { httpStatusCode?: number };
    };
    if (error.name !== undefined && CREDENTIAL_ERROR_NAMES.has(error.name)) {
      return false;
    }
    if (error.name === 'AccessDenied' || error.$metadata?.httpStatusCode === 403) {
      return true;
    }
    current = error.cause;
  }
  return false;
}
