import { isAccessDeniedError } from '../../../src/storage/errors';

// The SDK gives an S3 error the name of the error code and the HTTP status in $metadata.
const s3Error = (status: number, name: string): Error =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('isAccessDeniedError', () => {
  it('matches an AccessDenied error, with and without its 403 status', () => {
    expect(isAccessDeniedError(s3Error(403, 'AccessDenied'))).toBe(true);
    expect(isAccessDeniedError(Object.assign(new Error('x'), { name: 'AccessDenied' }))).toBe(true);
  });

  it('matches a 403 that has no error code in the body', () => {
    expect(isAccessDeniedError(s3Error(403, 'Forbidden'))).toBe(true);
  });

  it('matches an access-denied error that another error wraps as its cause', () => {
    const wrapped = new Error('upload failed', { cause: s3Error(403, 'AccessDenied') });
    expect(isAccessDeniedError(wrapped)).toBe(true);
  });

  it.each([
    'InvalidAccessKeyId',
    'SignatureDoesNotMatch',
    'RequestTimeTooSkewed',
    'ExpiredToken',
    'InvalidToken',
    'TokenRefreshRequired',
  ])('does not match a 403 %s, because the credentials are wrong, not read-only', (name) => {
    expect(isAccessDeniedError(s3Error(403, name))).toBe(false);
    expect(isAccessDeniedError(new Error('upload failed', { cause: s3Error(403, name) }))).toBe(
      false
    );
  });

  it.each([
    s3Error(404, 'NoSuchKey'),
    s3Error(401, 'Unauthorized'),
    s3Error(503, 'SlowDown'),
    new Error('Access Denied'),
    'AccessDenied',
    undefined,
  ])('does not match %p', (err) => {
    expect(isAccessDeniedError(err)).toBe(false);
  });
});
