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

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const CONTENT_SHA256_HEADER = 'x-amz-content-sha256';
const UNSIGNED_PAYLOAD_MIDDLEWARE = 'cloudCacheUnsignedPayload';
/** Commands that carry the large upload bodies. */
const UNSIGNED_PAYLOAD_COMMANDS = new Set(['UploadPartCommand', 'PutObjectCommand']);
/**
 * S3 error codes that can mean the server refuses `UNSIGNED-PAYLOAD`. `SignatureDoesNotMatch`
 * is also the code for wrong credentials. In that case the signed retry fails with the same
 * error, so the cost is one request.
 */
const UNSIGNED_PAYLOAD_REFUSALS = new Set([
  'XAmzContentSHA256Mismatch',
  'InvalidRequest',
  'NotImplemented',
  'SignatureDoesNotMatch',
]);

/**
 * Decides whether upload requests carry `UNSIGNED-PAYLOAD` instead of a payload hash. The action
 * checks its own sha256 on restore, and TLS protects the bytes in transit. Over plain HTTP the
 * payload hash is the only integrity in transit, so the default is off there.
 * `CLOUD_CACHE_UNSIGNED_PAYLOAD` overrides the default with `true` or `false`.
 */
export function useUnsignedPayload(
  endpoint: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const override = env.CLOUD_CACHE_UNSIGNED_PAYLOAD?.trim().toLowerCase();
  if (override === 'true') {
    return true;
  }
  if (override === 'false') {
    return false;
  }
  return !endpoint || endpoint.startsWith('https://');
}

/**
 * Decides whether the SDK adds its own CRC checksums where an operation allows them. The default
 * is off: the sha256 check on restore covers the archive, and the CRC32 costs main-thread CPU.
 * `CLOUD_CACHE_SDK_CHECKSUMS=true` turns them back on, for example for an AWS bucket with an
 * Object Lock default retention, which requires a checksum on each upload.
 */
export function useSdkChecksums(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLOUD_CACHE_SDK_CHECKSUMS?.trim().toLowerCase() === 'true';
}

/**
 * Returns the S3 error code when the error is a refusal of `UNSIGNED-PAYLOAD`, and undefined
 * otherwise. The SDK always sets `name`, so `name` and `Code` are checked separately.
 */
function unsignedPayloadRefusal(error: unknown): string | undefined {
  const e = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  if (status !== 400 && status !== 403) {
    return undefined;
  }
  return [e?.name, e?.Code].find(
    (code): code is string => code !== undefined && UNSIGNED_PAYLOAD_REFUSALS.has(code)
  );
}

/**
 * Adds the `UNSIGNED-PAYLOAD` middleware. SigV4 then skips the second hash pass over each part.
 * When the server refuses the header, the middleware turns off for this client and sends the
 * request again with a signed payload.
 */
function addUnsignedPayloadMiddleware(client: S3Client): void {
  let enabled = true;
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const request = args.request as { headers?: Record<string, string> } | undefined;
      const applies = UNSIGNED_PAYLOAD_COMMANDS.has(context.commandName ?? '');
      if (!enabled || !applies || !request?.headers) {
        return next(args);
      }
      request.headers[CONTENT_SHA256_HEADER] = UNSIGNED_PAYLOAD;
      try {
        return await next(args);
      } catch (error) {
        const code = unsignedPayloadRefusal(error);
        if (code === undefined) {
          throw error;
        }
        if (enabled) {
          enabled = false;
          core.info(
            `The server refused UNSIGNED-PAYLOAD (${code}). Uploads for this client now sign the payload hash.`
          );
        }
        delete request.headers[CONTENT_SHA256_HEADER];
        return next(args);
      }
    },
    { step: 'build', name: UNSIGNED_PAYLOAD_MIDDLEWARE }
  );
}

const GCS_GENERATION_HEADER = 'x-goog-generation';
const GCS_GENERATION_MIDDLEWARE = 'cloudCacheGcsGeneration';
/** Commands that write an object, whose generation the metadata copy pins its source to. */
const OBJECT_WRITE_COMMANDS = new Set(['PutObjectCommand', 'CompleteMultipartUploadCommand']);

/**
 * Reports the generation that GCS gives each written object as its `VersionId`, as GCS maps
 * `x-amz-version-id` to `x-goog-generation`. The SDK reads only the `x-amz-*` header, so without
 * this a write on GCS has no version id.
 */
function addGcsGenerationMiddleware(client: S3Client): void {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args);
      if (!OBJECT_WRITE_COMMANDS.has(context.commandName ?? '')) {
        return result;
      }
      const headers = (result.response as { headers?: Record<string, string> } | undefined)
        ?.headers;
      const generation = headers?.[GCS_GENERATION_HEADER];
      const output = result.output as { VersionId?: string };
      if (generation && output.VersionId === undefined) {
        output.VersionId = generation;
      }
      return result;
    },
    { step: 'build', name: GCS_GENERATION_MIDDLEWARE }
  );
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

  // Several S3-compatible services reject the CRC checksums the SDK sends by default. On AWS the
  // CRC32 costs about 100 ms of main-thread CPU per 64 MiB part, and the sha256 check on restore
  // already covers the archive, so no provider sends a checksum unless the operation needs one.
  if (!useSdkChecksums()) {
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

  const client = new S3Client(clientConfig);
  if (useUnsignedPayload(providerConfig.endpoint)) {
    addUnsignedPayloadMiddleware(client);
  }
  if (providerConfig.provider === 'gcs') {
    addGcsGenerationMiddleware(client);
  }

  return {
    client,
    providerConfig,
    bucket,
  };
}
