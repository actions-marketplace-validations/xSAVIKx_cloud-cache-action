import { getTestS3Config, prepareTestBucket } from '../../support/s3Server';

describe('test S3 server config', () => {
  it('defaults to the local SeaweedFS with the CI identity', () => {
    expect(getTestS3Config({})).toEqual({
      endpoint: 'http://127.0.0.1:8333',
      region: 'us-east-1',
      accessKeyId: 'cloudcacheci',
      secretAccessKey: 'cloudcachecisecret',
      provider: 'seaweedfs',
      bucket: 'cloud-cache-test',
      required: false,
    });
  });

  it('reads overrides from TEST_S3_* and REQUIRE_S3', () => {
    expect(
      getTestS3Config({
        TEST_S3_ENDPOINT: 'http://127.0.0.1:3900',
        TEST_S3_REGION: 'garage',
        TEST_S3_ACCESS_KEY: 'GK0123456789abcdef01234567',
        TEST_S3_SECRET_KEY: 'secret',
        TEST_S3_PROVIDER: 'garage',
        TEST_S3_BUCKET: 'other',
        REQUIRE_S3: '1',
      })
    ).toEqual({
      endpoint: 'http://127.0.0.1:3900',
      region: 'garage',
      accessKeyId: 'GK0123456789abcdef01234567',
      secretAccessKey: 'secret',
      provider: 'garage',
      bucket: 'other',
      required: true,
    });
  });

  it('reports an unreachable server as unavailable when S3 is optional', async () => {
    const config = { ...getTestS3Config({}), endpoint: 'http://127.0.0.1:1' };
    await expect(prepareTestBucket(config)).resolves.toBe(false);
  });

  it('fails on an unreachable server when REQUIRE_S3=1', async () => {
    const config = { ...getTestS3Config({}), endpoint: 'http://127.0.0.1:1', required: true };
    await expect(prepareTestBucket(config)).rejects.toThrow('REQUIRE_S3=1');
  });
});
