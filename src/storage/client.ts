import { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import * as core from '@actions/core';
import { ProviderConfig, resolveProviderDefaults } from './providers';
import { getInputWithEnv, getInputAsBool } from '../utils/inputUtils';
import { Inputs } from '../constants';

export interface StorageContext {
  client: S3Client;
  providerConfig: ProviderConfig;
  bucket: string;
}

export function createStorageContext(): StorageContext {
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
  };

  if (providerConfig.endpoint) {
    clientConfig.endpoint = providerConfig.endpoint;
  }

  if (accessKey && secretKey) {
    clientConfig.credentials = {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      sessionToken: sessionToken || undefined,
    };
  }

  core.debug(
    `Configuring S3 client for provider: ${providerConfig.provider} (endpoint: ${
      providerConfig.endpoint || 'AWS default'
    }, region: ${providerConfig.region}, forcePathStyle: ${providerConfig.forcePathStyle})`
  );

  const client = new S3Client(clientConfig);

  return {
    client,
    providerConfig,
    bucket,
  };
}
