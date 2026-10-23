import { jest } from '@jest/globals';
import { Inputs } from '../../src/constants';

const mockGetInput = jest.fn<(name: string) => string>();
const mockDebug = jest.fn<(message: string) => void>();
const mockWarning = jest.fn<(message: string) => void>();
const mockInfo = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: mockGetInput,
  debug: mockDebug,
  warning: mockWarning,
  info: mockInfo,
}));

const { CompleteMultipartUploadCommand, HeadObjectCommand, UploadPartCommand } = await import(
  '@aws-sdk/client-s3'
);
const { createStorageContext, useSdkChecksums, useUnsignedPayload } = await import(
  '../../src/storage/client'
);

describe('Storage Client Context Factory', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockGetInput.mockReturnValue('');
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws an error if bucket name is not provided', () => {
    delete process.env.AWS_S3_BUCKET;
    delete process.env.S3_BUCKET;

    expect(() => createStorageContext({ maxAttempts: 1 })).toThrow('Bucket name is required');
  });

  it('initializes client from input parameters', () => {
    mockGetInput.mockImplementation((name: string) => {
      switch (name) {
        case Inputs.Bucket:
          return 'my-test-bucket';
        case Inputs.Region:
          return 'eu-central-1';
        case Inputs.Endpoint:
          return 'https://s3.eu-central-1.amazonaws.com';
        case Inputs.AccessKey:
          return 'MOCK_KEY';
        case Inputs.SecretKey:
          return 'MOCK_SECRET';
        case Inputs.SessionToken:
          return 'MOCK_TOKEN';
        case Inputs.ForcePathStyle:
          return 'true';
        default:
          return '';
      }
    });

    const context = createStorageContext({ maxAttempts: 1 });

    expect(context.bucket).toBe('my-test-bucket');
    expect(context.providerConfig.region).toBe('eu-central-1');
    expect(context.providerConfig.forcePathStyle).toBe(true);
    expect(context.client).toBeDefined();
  });

  it('falls back to environment variables when inputs are missing', () => {
    process.env.AWS_S3_BUCKET = 'env-bucket';
    process.env.AWS_REGION = 'us-west-2';
    process.env.AWS_ACCESS_KEY_ID = 'ENV_KEY';
    process.env.AWS_SECRET_ACCESS_KEY = 'ENV_SECRET';

    const context = createStorageContext({ maxAttempts: 1 });

    expect(context.bucket).toBe('env-bucket');
    expect(context.providerConfig.region).toBe('us-west-2');
  });

  it('handles custom S3-compatible provider endpoint without explicit credentials', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Bucket) return 'garage-bucket';
      if (name === Inputs.Endpoint) return 'http://127.0.0.1:3900';
      return '';
    });

    const context = createStorageContext({ maxAttempts: 1 });

    expect(context.bucket).toBe('garage-bucket');
    expect(context.providerConfig.provider).toBe('garage');
    expect(context.providerConfig.forcePathStyle).toBe(true);
  });

  const inputsOf =
    (values: Record<string, string>) =>
    (name: string): string =>
      values[name] ?? '';

  it('passes the attempt count and standard retry mode to the SDK', async () => {
    mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
    const { client } = createStorageContext({ maxAttempts: 4 });
    await expect(client.config.maxAttempts()).resolves.toBe(4);
    expect(client.config.retryMode).toBe('standard');
  });

  it('only sends checksums when required for S3-compatible providers', async () => {
    mockGetInput.mockImplementation(
      inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.Endpoint]: 'https://storage.googleapis.com' })
    );
    const { client } = createStorageContext({ maxAttempts: 1 });
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
    await expect(client.config.responseChecksumValidation()).resolves.toBe('WHEN_REQUIRED');
  });

  it('only sends checksums when required for AWS too', async () => {
    mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
    const { client } = createStorageContext({ maxAttempts: 1 });
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED');
    await expect(client.config.responseChecksumValidation()).resolves.toBe('WHEN_REQUIRED');
  });

  it('keeps the SDK checksum defaults when CLOUD_CACHE_SDK_CHECKSUMS is true', async () => {
    mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
    process.env.CLOUD_CACHE_SDK_CHECKSUMS = 'true';
    try {
      const { client } = createStorageContext({ maxAttempts: 1 });
      await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_SUPPORTED');
      await expect(client.config.responseChecksumValidation()).resolves.toBe('WHEN_SUPPORTED');
    } finally {
      delete process.env.CLOUD_CACHE_SDK_CHECKSUMS;
    }
  });

  it.each([
    [undefined, false],
    ['true', true],
    [' TRUE ', true],
    ['false', false],
    ['yes', false],
  ])('reads CLOUD_CACHE_SDK_CHECKSUMS=%p as %p', (value, expected) => {
    expect(useSdkChecksums(value === undefined ? {} : { CLOUD_CACHE_SDK_CHECKSUMS: value })).toBe(
      expected
    );
  });

  it('warns about an unknown provider', () => {
    mockGetInput.mockImplementation(
      inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.Provider]: 'cloudflare-r2' })
    );
    const { providerConfig } = createStorageContext({ maxAttempts: 1 });
    expect(providerConfig.provider).toBe('generic-s3');
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Unknown provider "cloudflare-r2"')
    );
  });

  it('warns when only one of access-key and secret-key is set', () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    mockGetInput.mockImplementation(
      inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.AccessKey]: 'only-the-id' })
    );
    createStorageContext({ maxAttempts: 1 });
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Only one of access-key and secret-key is set')
    );
  });

  it('warns when only secret-key is set', () => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    mockGetInput.mockImplementation(
      inputsOf({ [Inputs.Bucket]: 'bucket', [Inputs.SecretKey]: 'only-the-secret' })
    );
    createStorageContext({ maxAttempts: 1 });
    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining('Only one of access-key and secret-key is set')
    );
  });
});

describe('useUnsignedPayload', () => {
  it.each([
    [undefined, {}, true],
    ['https://x.r2.cloudflarestorage.com', {}, true],
    ['http://127.0.0.1:9000', {}, false],
    ['http://127.0.0.1:9000', { CLOUD_CACHE_UNSIGNED_PAYLOAD: 'true' }, true],
    ['https://s3.example', { CLOUD_CACHE_UNSIGNED_PAYLOAD: 'false' }, false],
    ['https://s3.example', { CLOUD_CACHE_UNSIGNED_PAYLOAD: 'maybe' }, true],
  ])('endpoint %s with %j gives %s', (endpoint, env, expected) => {
    expect(useUnsignedPayload(endpoint, env)).toBe(expected);
  });
});

describe('UNSIGNED-PAYLOAD middleware', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.CLOUD_CACHE_UNSIGNED_PAYLOAD;
    mockGetInput.mockImplementation((name: string) => {
      const values: Record<string, string> = {
        [Inputs.Bucket]: 'b',
        [Inputs.Endpoint]: 'https://s3.example.test',
        [Inputs.AccessKey]: 'K',
        [Inputs.SecretKey]: 'S',
      };
      return values[name] ?? '';
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /**
   * Replaces the network with a fake handler. `respond` sees the request headers and either
   * returns or throws; the headers of every request are recorded in order.
   */
  function stubNetwork(
    client: ReturnType<typeof createStorageContext>['client'],
    respond: (headers: Record<string, string>) => void
  ): Array<Record<string, string>> {
    const seen: Array<Record<string, string>> = [];
    client.middlewareStack.add(
      (_next) => async (args) => {
        const headers = { ...(args.request as { headers: Record<string, string> }).headers };
        seen.push(headers);
        respond(headers);
        return { output: { $metadata: {} }, response: {} } as never;
      },
      { step: 'finalizeRequest', name: 'fakeNetwork', priority: 'low' }
    );
    return seen;
  }

  const part = () =>
    new UploadPartCommand({
      Bucket: 'b',
      Key: 'k',
      UploadId: 'u',
      PartNumber: 1,
      Body: Buffer.from('x'),
    });
  const refusal = (name: string, status = 400) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it('sets the header on UploadPart and not on HeadObject', async () => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, () => undefined);

    await client.send(part());
    await client.send(new HeadObjectCommand({ Bucket: 'b', Key: 'k' }));

    expect(seen[0]['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(seen[1]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
  });

  it('does not add the middleware over plain HTTP', async () => {
    mockGetInput.mockImplementation((name: string) => {
      const values: Record<string, string> = {
        [Inputs.Bucket]: 'b',
        [Inputs.Endpoint]: 'http://127.0.0.1:9000',
        [Inputs.AccessKey]: 'K',
        [Inputs.SecretKey]: 'S',
      };
      return values[name] ?? '';
    });
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, () => undefined);

    await client.send(part());

    expect(seen[0]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
  });

  it.each([
    ['XAmzContentSHA256Mismatch', 400],
    ['InvalidRequest', 400],
    ['NotImplemented', 403],
    ['SignatureDoesNotMatch', 403],
  ])('retries once signed and stays signed after %s', async (code, status) => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, (headers) => {
      if (headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD') {
        throw refusal(code, status);
      }
    });

    await client.send(part());
    await client.send(part());

    expect(seen).toHaveLength(3);
    expect(seen[1]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
    expect(seen[2]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockInfo.mock.calls[0][0]).toContain(code);
  });

  it('finds the code in Code when name is generic, and logs that code', async () => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, (headers) => {
      if (headers['x-amz-content-sha256'] === 'UNSIGNED-PAYLOAD') {
        throw Object.assign(new Error('refused'), {
          name: 'S3ServiceException',
          Code: 'XAmzContentSHA256Mismatch',
          $metadata: { httpStatusCode: 400 },
        });
      }
    });

    await client.send(part());

    expect(seen).toHaveLength(2);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockInfo.mock.calls[0][0]).toContain('(XAmzContentSHA256Mismatch)');
    expect(mockInfo.mock.calls[0][0]).not.toContain('undefined');
  });

  it('fails when the signed retry fails with the same credential error', async () => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, () => {
      throw refusal('SignatureDoesNotMatch', 403);
    });

    await expect(client.send(part())).rejects.toThrow('SignatureDoesNotMatch');
    expect(seen).toHaveLength(2);
    expect(seen[1]['x-amz-content-sha256']).not.toBe('UNSIGNED-PAYLOAD');
  });

  it('does not retry other errors', async () => {
    const { client } = createStorageContext({ maxAttempts: 1 });
    const seen = stubNetwork(client, () => {
      throw refusal('AccessDenied', 403);
    });

    await expect(client.send(part())).rejects.toThrow('AccessDenied');
    expect(seen).toHaveLength(1);
    expect(mockInfo).not.toHaveBeenCalled();
  });
});

describe('GCS generation middleware', () => {
  const endpointInput = (endpoint: string) => (name: string) => {
    const values: Record<string, string> = {
      [Inputs.Bucket]: 'b',
      [Inputs.Endpoint]: endpoint,
      [Inputs.AccessKey]: 'K',
      [Inputs.SecretKey]: 'S',
    };
    return values[name] ?? '';
  };

  /** Replaces the network with a fake handler that answers with these response headers. */
  function answerWith(
    client: ReturnType<typeof createStorageContext>['client'],
    headers: Record<string, string>
  ): void {
    client.middlewareStack.add(
      (_next) => async () => ({ output: { $metadata: {} }, response: { headers } }) as never,
      { step: 'finalizeRequest', name: 'fakeNetwork', priority: 'low' }
    );
  }

  const complete = () =>
    new CompleteMultipartUploadCommand({ Bucket: 'b', Key: 'k', UploadId: 'u' });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports the x-goog-generation of a GCS write as the VersionId', async () => {
    mockGetInput.mockImplementation(endpointInput('https://storage.googleapis.com'));
    const { client } = createStorageContext({ maxAttempts: 1 });
    answerWith(client, { 'x-goog-generation': '1761234567890123' });

    const output = await client.send(complete());

    expect(output.VersionId).toBe('1761234567890123');
  });

  it('leaves the VersionId alone on other providers', async () => {
    mockGetInput.mockImplementation(endpointInput('https://s3.example.test'));
    const { client } = createStorageContext({ maxAttempts: 1 });
    answerWith(client, { 'x-goog-generation': '1761234567890123' });

    const output = await client.send(complete());

    expect(output.VersionId).toBeUndefined();
  });
});
