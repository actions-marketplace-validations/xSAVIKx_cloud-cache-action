import { jest } from '@jest/globals';

jest.unstable_mockModule('@actions/core', () => ({ info: jest.fn() }));

const { isRetryableError, isRetryableStreamError, withRetry } = await import(
  '../../../src/storage/retry'
);

const httpError = (status: number, name = 'Error'): Error =>
  Object.assign(new Error(`HTTP ${status}`), { name, $metadata: { httpStatusCode: status } });
const networkError = (code: string): Error => Object.assign(new Error(code), { code });
const namedError = (name: string): Error => Object.assign(new Error(name), { name });

describe('isRetryableError', () => {
  it.each([500, 502, 503, 429])('retries HTTP %i', (status) => {
    expect(isRetryableError(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404])('does not retry HTTP %i', (status) => {
    expect(isRetryableError(httpError(status))).toBe(false);
  });

  it.each(['SlowDown', 'ThrottlingException', 'RequestTimeout'])('retries %s', (name) => {
    expect(isRetryableError(namedError(name))).toBe(true);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN'])(
    'retries network error %s',
    (code) => {
      expect(isRetryableError(networkError(code))).toBe(true);
    }
  );

  it('retries dropped sockets and prematurely closed streams', () => {
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new Error('Premature close'))).toBe(true);
  });

  it('retries errors the SDK marks as retryable', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { $retryable: {} }))).toBe(true);
  });

  it.each(['AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId'])('does not retry %s', (name) => {
    expect(isRetryableError(httpError(403, name))).toBe(false);
  });

  it('does not retry a 412 precondition failure', () => {
    expect(isRetryableError(httpError(412, 'PreconditionFailed'))).toBe(false);
  });

  it('does not retry values that are not errors', () => {
    expect(isRetryableError(undefined)).toBe(false);
    expect(isRetryableError('boom')).toBe(false);
  });
});

describe('isRetryableStreamError', () => {
  it('retries a dropped connection the SDK never saw', () => {
    expect(isRetryableStreamError(networkError('ECONNRESET'))).toBe(true);
  });

  it('retries a prematurely closed stream', () => {
    expect(isRetryableStreamError(new Error('Premature close'))).toBe(true);
  });

  it('does not retry an HTTP 503 the SDK already retried', () => {
    expect(isRetryableStreamError(httpError(503))).toBe(false);
  });

  it('does not retry a network error that carries SDK retry metadata', () => {
    const retried = Object.assign(networkError('ECONNRESET'), { $metadata: { attempts: 4 } });
    expect(isRetryableStreamError(retried)).toBe(false);
  });

  it('does not retry AccessDenied', () => {
    expect(isRetryableStreamError(namedError('AccessDenied'))).toBe(false);
    expect(isRetryableStreamError(httpError(403, 'AccessDenied'))).toBe(false);
  });

  it('does not retry a 412 precondition failure', () => {
    expect(isRetryableStreamError(httpError(412, 'PreconditionFailed'))).toBe(false);
  });
});

describe('withRetry', () => {
  const fast = { minTimeoutMs: 1, maxJitterMs: 0 };

  it('retries a retryable failure until it succeeds', async () => {
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(networkError('ECONNRESET'))
      .mockResolvedValueOnce('ok');
    await expect(withRetry(operation, { retries: 2, ...fast })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('throws a non-retryable failure straight away', async () => {
    const error = httpError(403, 'AccessDenied');
    const operation = jest.fn<() => Promise<string>>().mockRejectedValue(error);
    await expect(withRetry(operation, { retries: 3, ...fast })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of retries', async () => {
    const operation = jest.fn<() => Promise<string>>().mockRejectedValue(networkError('ETIMEDOUT'));
    await expect(withRetry(operation, { retries: 2, ...fast })).rejects.toThrow('ETIMEDOUT');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('makes exactly one attempt when retries is 0', async () => {
    const operation = jest.fn<() => Promise<string>>().mockRejectedValue(networkError('EPIPE'));
    await expect(withRetry(operation, { retries: 0, ...fast })).rejects.toThrow('EPIPE');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('accepts a custom retry predicate', async () => {
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('custom'))
      .mockResolvedValueOnce('ok');
    await expect(
      withRetry(operation, { retries: 1, ...fast, shouldRetry: () => true })
    ).resolves.toBe('ok');
  });
});
