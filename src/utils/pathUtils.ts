import * as path from 'path';

export interface S3KeyParams {
  key: string;
  prefix?: string;
  archiveFilename: string;
  repository?: string;
  pattern?: string;
  scopedToRepository?: boolean;
}

/**
 * Normalizes all path separators to POSIX forward slashes and collapses multiple slashes.
 */
export function normalizeS3Key(keyPath: string): string {
  // Replace backslashes with forward slashes
  let normalized = keyPath.replace(/\\+/g, '/');
  // Collapse consecutive forward slashes
  normalized = normalized.replace(/\/+/g, '/');
  // Strip leading slash if present
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

/**
 * Resolves the full S3 object key using the template pattern or default conventions.
 */
/**
 * Resolves placeholders from special variables and process.env.
 */
export function resolveTemplateVariables(
  template: string,
  specialVars: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): string {
  // First, resolve braced syntax: ${VAR_NAME} or ${env.VAR_NAME}
  let result = template.replace(/\$\{([A-Za-z0-9_.-]+)\}/g, (_, varName: string) => {
    if (varName in specialVars) {
      return specialVars[varName];
    }
    if (varName.startsWith('env.')) {
      const envKey = varName.slice(4);
      return env[envKey] ?? '';
    }
    if (varName in env) {
      return env[varName] ?? '';
    }
    return '';
  });

  // Second, resolve unbraced syntax: $VAR_NAME
  result = result.replace(/\$([A-Za-z0-9_]+)/g, (_, varName: string) => {
    if (varName in specialVars) {
      return specialVars[varName];
    }
    if (varName in env) {
      return env[varName] ?? '';
    }
    return '';
  });

  return result;
}

/**
 * Resolves the full S3 object key using the template pattern or default conventions.
 */
export function buildS3ObjectKey(
  params: S3KeyParams,
  env: NodeJS.ProcessEnv = process.env
): string {
  const repository = params.repository || env.GITHUB_REPOSITORY || '';
  const prefix = params.prefix ? normalizePrefix(params.prefix) : '';
  const key = params.key.trim();
  const archiveFilename = params.archiveFilename;

  // If pattern is explicitly provided or using default pattern
  let pattern = params.pattern || '${GITHUB_REPOSITORY}/${prefix}${key}/${archive_filename}';

  // If repository scoping is explicitly turned off and user didn't provide custom pattern,
  // remove ${GITHUB_REPOSITORY}/
  if (params.scopedToRepository === false && (!params.pattern || params.pattern.includes('${GITHUB_REPOSITORY}'))) {
    pattern = pattern.replace('${GITHUB_REPOSITORY}/', '').replace('${GITHUB_REPOSITORY}', '');
  }

  const specialVars: Record<string, string> = {
    GITHUB_REPOSITORY: repository,
    prefix,
    key,
    archive_filename: archiveFilename,
  };

  const resolved = resolveTemplateVariables(pattern, specialVars, env);
  return normalizeS3Key(resolved);
}

/**
 * Calculates the S3 prefix used for searching/listing objects for a given restoreKey.
 */
export function buildS3SearchPrefix(
  restoreKey: string,
  params: Omit<S3KeyParams, 'key' | 'archiveFilename'>,
  env: NodeJS.ProcessEnv = process.env
): string {
  const repository = params.repository || env.GITHUB_REPOSITORY || '';
  const prefix = params.prefix ? normalizePrefix(params.prefix) : '';
  const trimmedRestoreKey = restoreKey.trim();

  let pattern = params.pattern || '${GITHUB_REPOSITORY}/${prefix}${key}/${archive_filename}';

  if (params.scopedToRepository === false && (!params.pattern || params.pattern.includes('${GITHUB_REPOSITORY}'))) {
    pattern = pattern.replace('${GITHUB_REPOSITORY}/', '').replace('${GITHUB_REPOSITORY}', '');
  }

  // Find where ${key} or $key starts in the pattern
  const keyMarkerIndex = pattern.indexOf('${key}') !== -1 ? pattern.indexOf('${key}') : pattern.indexOf('$key');
  if (keyMarkerIndex !== -1) {
    const beforeKey = pattern.slice(0, keyMarkerIndex);
    const specialVars: Record<string, string> = {
      GITHUB_REPOSITORY: repository,
      prefix,
    };
    const resolvedBefore = resolveTemplateVariables(beforeKey, specialVars, env);
    return normalizeS3Key(`${resolvedBefore}${trimmedRestoreKey}`);
  }

  // Fallback if no key placeholder
  return normalizeS3Key(`${repository}/${prefix}${trimmedRestoreKey}`);
}

/**
 * Extracts the cache key name from a full S3 object key based on pattern and search prefix.
 */
export function extractKeyFromS3Object(
  objectKey: string,
  searchPrefix: string,
  archiveFilename: string
): string {
  const normalizedObject = normalizeS3Key(objectKey);
  const normalizedPrefix = normalizeS3Key(searchPrefix);

  // Remove archive filename at the end
  let candidate = normalizedObject;
  if (candidate.endsWith(`/${archiveFilename}`)) {
    candidate = candidate.slice(0, -(archiveFilename.length + 1));
  } else if (candidate.endsWith(archiveFilename)) {
    candidate = candidate.slice(0, -archiveFilename.length);
  }

  // The base name of candidate is our key
  const parts = candidate.split('/');
  return parts[parts.length - 1] || candidate;
}

/**
 * Ensures prefix has trailing slash if non-empty, and strips leading slash.
 */
export function normalizePrefix(prefix: string): string {
  let p = prefix.replace(/\\+/g, '/').trim();
  if (p.startsWith('/')) {
    p = p.slice(1);
  }
  if (p && !p.endsWith('/')) {
    p += '/';
  }
  return p;
}

/**
 * Resolves local file paths for archiving.
 */
export function resolveArchivePaths(patterns: string[]): string[] {
  const cwd = process.cwd();
  return patterns.map((p) => {
    if (path.isAbsolute(p)) {
      return path.relative(cwd, p);
    }
    return p;
  });
}
