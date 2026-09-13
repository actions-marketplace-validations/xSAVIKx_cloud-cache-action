import { readFileSync } from 'node:fs';

export interface RefCandidates {
  /** The ref saves are written under; undefined when GITHUB_REF is not set. */
  current?: string;
  /** Refs a restore searches, in order: current, pull request base, default branch. */
  restore: string[];
}

function readDefaultBranch(
  eventPath: string | undefined,
  readFile: (file: string) => string
): string | undefined {
  if (!eventPath) {
    return undefined;
  }
  try {
    const payload = JSON.parse(readFile(eventPath)) as {
      repository?: { default_branch?: unknown };
    };
    const branch = payload.repository?.default_branch;
    return typeof branch === 'string' && branch ? branch : undefined;
  } catch {
    return undefined;
  }
}

/** Mirrors actions/cache: a run may restore from its own ref, its PR base, and the default branch. */
export function resolveRefCandidates(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (file: string) => string = (file) => readFileSync(file, 'utf8')
): RefCandidates {
  const current = env.GITHUB_REF?.trim() || undefined;
  if (!current) {
    return { current: undefined, restore: [] };
  }

  const candidates = [current];
  const baseRef = env.GITHUB_BASE_REF?.trim();
  if (baseRef) {
    candidates.push(`refs/heads/${baseRef}`);
  }
  const defaultBranch = readDefaultBranch(env.GITHUB_EVENT_PATH, readFile);
  if (defaultBranch) {
    candidates.push(`refs/heads/${defaultBranch}`);
  }
  return { current, restore: [...new Set(candidates)] };
}
