import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import * as core from '@actions/core';
import { ProviderConfig, isKnownProvider, resolveProviderDefaults } from './providers';
import { getInputWithEnv, getInputAsBool } from '../utils/inputUtils';
import { Inputs } from '../constants';

export interface StorageContext {
  client: S3Client;
  providerConfig: ProviderConfig;
  bucket: string;
  /**
   * Set by `saveToS3` once this context's server has rejected a conditional (`If-None-Match`)
   * upload as unsupported, so later uploads through the same context skip the condition instead
   * of failing the same way again.
   */
  conditionalWriteUnsupported?: boolean;
  /** Set once this context's server has rejected object tagging, so later uploads omit tags. */
  objectTaggingUnsupported?: boolean;
}

export interface StorageClientOptions {
  /** Total SDK attempts per request, including the first one. */
  maxAttempts: number;
}

export function createStorageContext(options: StorageClientOptions): StorageContext {
  const bucket = getInputWithEnv(Inputs.Bucket, ['AWS_S3_BUCKET', 'S3_BUCKET']);
  if (!bucket) {
    throw new Error(
      'Bucket name is required. Please set "bucket" input or AWS_S3_BUCKET environment variable.'
    );
  }

  const endpointInput = getInputWithEnv(Inputs.Endpoint, [
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_S3',
  ]);
  const regionInput = getInputWithEnv(Inputs.Region, ['AWS_REGION', 'AWS_DEFAULT_REGION']);
  const providerInput = core.getInput(Inputs.Provider);
  if (providerInput && !isKnownProvider(providerInput)) {
    core.warning(`Unknown provider "${providerInput}"; using generic S3-compatible defaults.`);
  }

  const forcePathStyleRaw = core.getInput(Inputs.ForcePathStyle);
  const forcePathStyleInput =
    forcePathStyleRaw !== '' ? getInputAsBool(Inputs.ForcePathStyle) : undefined;

  const providerConfig = resolveProviderDefaults(
    endpointInput,
    regionInput,
    forcePathStyleInput,
    providerInput
  );

  const accessKey = getInputWithEnv(Inputs.AccessKey, ['AWS_ACCESS_KEY_ID'], Inputs.AccessKeyCamel);
  const secretKey = getInputWithEnv(
    Inputs.SecretKey,
    ['AWS_SECRET_ACCESS_KEY'],
    Inputs.SecretKeyCamel
  );
  const sessionToken = getInputWithEnv(
    Inputs.SessionToken,
    ['AWS_SESSION_TOKEN'],
    Inputs.SessionTokenCamel
  );

  const clientConfig: S3ClientConfig = {
    region: providerConfig.region,
    forcePathStyle: providerConfig.forcePathStyle,
    maxAttempts: Math.max(1, options.maxAttempts),
    retryMode: 'standard',
  };

  if (providerConfig.endpoint) {
    clientConfig.endpoint = providerConfig.endpoint;
  }

  if (providerConfig.provider !== 'aws') {
    // Several S3-compatible services reject the CRC checksums the SDK sends by default.
    clientConfig.requestChecksumCalculation = 'WHEN_REQUIRED';
    clientConfig.responseChecksumValidation = 'WHEN_REQUIRED';
  }

  if (accessKey && secretKey) {
    clientConfig.credentials = {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      sessionToken: sessionToken || undefined,
    };
  } else if (accessKey || secretKey) {
    core.warning(
      'Only one of access-key and secret-key is set; ignoring it and using the default AWS credential chain.'
    );
  }

  core.debug(
    `Configuring S3 client for provider: ${providerConfig.provider} (endpoint: ${
      providerConfig.endpoint || 'AWS default'
    }, region: ${providerConfig.region}, forcePathStyle: ${providerConfig.forcePathStyle}, maxAttempts: ${clientConfig.maxAttempts})`
  );

  return {
    client: new S3Client(clientConfig),
    providerConfig,
    bucket,
  };
}
