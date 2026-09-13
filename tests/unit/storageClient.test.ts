import { jest } from '@jest/globals';
import { Inputs } from '../../src/constants';

const mockGetInput = jest.fn<(name: string) => string>();
const mockDebug = jest.fn<(message: string) => void>();
const mockWarning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: mockGetInput,
  debug: mockDebug,
  warning: mockWarning,
}));

const { createStorageContext } = await import('../../src/storage/client');

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

  it('keeps the SDK checksum defaults for AWS', async () => {
    mockGetInput.mockImplementation(inputsOf({ [Inputs.Bucket]: 'bucket' }));
    const { client } = createStorageContext({ maxAttempts: 1 });
    await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_SUPPORTED');
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
});
