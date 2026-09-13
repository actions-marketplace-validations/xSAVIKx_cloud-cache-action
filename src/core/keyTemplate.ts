/**
 * Turns `s3-key-pattern` into object keys, listing prefixes and key extraction.
 *
 * The pattern is split around its single `${key}`. The text before it (the base) and after it
 * (the suffix) is resolved without the key, so a key is inserted verbatim and can be read back
 * by slicing the base and suffix off an object key, even when the key contains `/` or `$`.
 */

const SPECIAL_VARIABLES = new Set([
  'GITHUB_REPOSITORY',
  'prefix',
  'ref',
  'key',
  'version',
  'archive_filename',
]);
const KEY_PLACEHOLDER = '${key}';

export interface KeyTemplateOptions {
  pattern: string;
  repository: string;
  prefix: string;
  scopedToRepository: boolean;
  scopedToRef: boolean;
  version: string;
  archiveFilename: string;
  env?: NodeJS.ProcessEnv;
}

export interface KeyTemplate {
  objectKey(ref: string, key: string): string;
  searchPrefix(ref: string, keyPrefix: string): string;
  extractKey(ref: string, objectKey: string): string | undefined;
  readonly warnings: readonly string[];
}

/** Encodes a Git ref as one path segment: refs/heads/main becomes refs%2Fheads%2Fmain. */
export function encodeRef(ref: string): string {
  return encodeURIComponent(ref);
}

/** Forward slashes, no leading slash, and a trailing slash when non-empty. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  return trimmed && !trimmed.endsWith('/') ? `${trimmed}/` : trimmed;
}

/**
 * Expands `${env.NAME}`, `${NAME}` and `$NAME` in a single pass, so an expanded value is never
 * expanded again. Unset braced names become empty; unset bare names stay literal. Special
 * variables such as `${key}` are left for compileKeyTemplate.
 */
export function expandEnvironment(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(
    /\$\{([A-Za-z0-9_.-]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match: string, braced: string | undefined, bare: string | undefined) => {
      if (braced !== undefined) {
        if (SPECIAL_VARIABLES.has(braced)) {
          return match;
        }
        const name = braced.startsWith('env.') ? braced.slice(4) : braced;
        return env[name] ?? '';
      }
      return env[bare as string] ?? match;
    }
  );
}

function removePlaceholder(pattern: string, name: string): string {
  return pattern.split(`\${${name}}/`).join('').split(`\${${name}}`).join('');
}

function tidy(text: string): string {
  return text.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

export function compileKeyTemplate(options: KeyTemplateOptions): KeyTemplate {
  const keyCount = options.pattern.split(KEY_PLACEHOLDER).length - 1;
  if (keyCount !== 1) {
    throw new Error(
      `s3-key-pattern must contain \${key} exactly once (found ${keyCount}): "${options.pattern}"`
    );
  }

  let pattern = options.pattern;
  if (!options.scopedToRepository) {
    pattern = removePlaceholder(pattern, 'GITHUB_REPOSITORY');
  }
  if (!options.scopedToRef) {
    pattern = removePlaceholder(pattern, 'ref');
  }

  const warnings: string[] = [];
  if (options.scopedToRef && !pattern.includes('${ref}')) {
    warnings.push(
      's3-key-pattern has no ${ref}, so caches are shared by every branch and pull request.'
    );
  }
  if (!pattern.includes('${version}')) {
    warnings.push(
      's3-key-pattern has no ${version}, so a cache saved with different paths or compression can be restored as a hit.'
    );
  }

  const [before, after] = expandEnvironment(pattern, options.env ?? process.env).split(
    KEY_PLACEHOLDER
  );
  const prefix = normalizePrefix(options.prefix);
  const fill = (text: string, ref: string): string =>
    text.replace(
      /\$\{(GITHUB_REPOSITORY|prefix|ref|version|archive_filename)\}/g,
      (_match: string, name: string) => {
        switch (name) {
          case 'GITHUB_REPOSITORY':
            return options.repository;
          case 'prefix':
            return prefix;
          case 'ref':
            return encodeRef(ref);
          case 'version':
            return options.version;
          default:
            return options.archiveFilename;
        }
      }
    );
  const baseOf = (ref: string): string => tidy(fill(before, ref)).replace(/^\//, '');
  const suffixOf = (ref: string): string => tidy(fill(after, ref));

  return {
    warnings,
    objectKey: (ref, key) => `${baseOf(ref)}${key}${suffixOf(ref)}`,
    searchPrefix: (ref, keyPrefix) => `${baseOf(ref)}${keyPrefix}`,
    extractKey: (ref, objectKey) => {
      const head = baseOf(ref);
      const tail = suffixOf(ref);
      if (
        !objectKey.startsWith(head) ||
        !objectKey.endsWith(tail) ||
        objectKey.length <= head.length + tail.length
      ) {
        return undefined;
      }
      return objectKey.slice(head.length, objectKey.length - tail.length);
    },
  };
}
