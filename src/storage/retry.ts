import * as core from '@actions/core';

export interface RetryOptions {
  retries: number;
  minTimeoutMs?: number;
  factor?: number;
  operationName?: string;
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const retries = Math.max(0, options.retries);
  const minTimeout = options.minTimeoutMs ?? 1000;
  const factor = options.factor ?? 2;
  const opName = options.operationName || 'S3 operation';

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (attempt > retries) {
        break;
      }

      // Calculate exponential backoff with jitter
      const delay = Math.round(
        minTimeout * Math.pow(factor, attempt - 1) + Math.random() * 500
      );

      core.info(
        `Failed to ${opName}. Attempt ${attempt}/${retries + 1} failed: ${errorMessage}. Retrying in ${delay}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
