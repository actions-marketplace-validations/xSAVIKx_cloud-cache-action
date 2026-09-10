import { jest } from '@jest/globals';
import { Inputs } from '../../src/constants';

const mockGetInput = jest.fn<(name: string) => string>();
const mockDebug = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: mockGetInput,
  debug: mockDebug,
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

    expect(() => createStorageContext()).toThrow('Bucket name is required');
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

    const context = createStorageContext();

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

    const context = createStorageContext();

    expect(context.bucket).toBe('env-bucket');
    expect(context.providerConfig.region).toBe('us-west-2');
  });

  it('handles custom S3-compatible provider endpoint without explicit credentials', () => {
    mockGetInput.mockImplementation((name: string) => {
      if (name === Inputs.Bucket) return 'garage-bucket';
      if (name === Inputs.Endpoint) return 'http://127.0.0.1:3900';
      return '';
    });

    const context = createStorageContext();

    expect(context.bucket).toBe('garage-bucket');
    expect(context.providerConfig.provider).toBe('garage');
    expect(context.providerConfig.forcePathStyle).toBe(true);
  });
});
