import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { Inputs } from '../../../src/constants';
import type { CacheConfig } from '../../../src/core/config';
import { isWindows, makeTempDir, removeDir, setEnv, writeFiles } from '../../support/tempTree';

const inputs = new Map<string, string>();
const mockInfo = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  info: mockInfo,
  debug: jest.fn(),
  warning: jest.fn(),
}));

const { PRESET_NAMES, PRESETS, applyPreset, readPreset, runnerOs } = await import(
  '../../../src/core/presets'
);
const { resolveCachePaths } = await import('../../../src/archive/paths');

type Os = 'Linux' | 'macOS' | 'Windows';

const base = { primaryKey: '', paths: [], restoreKeys: [] } as unknown as CacheConfig;

/** A hash function that records the patterns it was given and returns a fixed digest. */
function fakeHash(digest = 'abc123') {
  return jest.fn<(patterns: string, workspace: string) => Promise<string>>(async () => digest);
}

// The expected per-OS paths. Each value comes from the tool's own documentation or from the
// actions/cache examples; docs/guide/presets.md cites the source for every preset.
const EXPECTED_PATHS: Record<string, Record<Os, string[]>> = {
  npm: {
    Linux: ['~/.npm'],
    macOS: ['~/.npm'],
    Windows: ['~\\AppData\\Local\\npm-cache'],
  },
  yarn: {
    Linux: ['~/.cache/yarn', '~/.yarn/berry/cache', '.yarn/cache'],
    macOS: ['~/Library/Caches/Yarn', '~/.yarn/berry/cache', '.yarn/cache'],
    Windows: [
      '~\\AppData\\Local\\Yarn\\Cache',
      '~\\AppData\\Local\\Yarn\\Berry\\cache',
      '.yarn\\cache',
    ],
  },
  pnpm: {
    Linux: ['~/.local/share/pnpm/store'],
    macOS: ['~/Library/pnpm/store'],
    Windows: ['~\\AppData\\Local\\pnpm\\store'],
  },
  bun: {
    Linux: ['~/.bun/install/cache'],
    macOS: ['~/.bun/install/cache'],
    Windows: ['~\\.bun\\install\\cache'],
  },
  pip: {
    Linux: ['~/.cache/pip'],
    macOS: ['~/Library/Caches/pip'],
    Windows: ['~\\AppData\\Local\\pip\\Cache'],
  },
  poetry: {
    Linux: ['~/.cache/pypoetry/cache', '~/.cache/pypoetry/artifacts'],
    macOS: ['~/Library/Caches/pypoetry/cache', '~/Library/Caches/pypoetry/artifacts'],
    Windows: [
      '~\\AppData\\Local\\pypoetry\\Cache\\cache',
      '~\\AppData\\Local\\pypoetry\\Cache\\artifacts',
    ],
  },

  uv: {
    Linux: ['~/.cache/uv'],
    macOS: ['~/.cache/uv'],
    Windows: ['~\\AppData\\Local\\uv\\cache'],
  },
  gradle: {
    Linux: ['~/.gradle/caches', '~/.gradle/wrapper'],
    macOS: ['~/.gradle/caches', '~/.gradle/wrapper'],
    Windows: ['~\\.gradle\\caches', '~\\.gradle\\wrapper'],
  },
  maven: {
    Linux: ['~/.m2/repository'],
    macOS: ['~/.m2/repository'],
    Windows: ['~\\.m2\\repository'],
  },
  cargo: {
    Linux: ['~/.cargo/registry/index', '~/.cargo/registry/cache', '~/.cargo/git/db'],
    macOS: ['~/.cargo/registry/index', '~/.cargo/registry/cache', '~/.cargo/git/db'],
    Windows: ['~\\.cargo\\registry\\index', '~\\.cargo\\registry\\cache', '~\\.cargo\\git\\db'],
  },
  go: {
    Linux: ['~/go/pkg/mod', '~/.cache/go-build'],
    macOS: ['~/go/pkg/mod', '~/Library/Caches/go-build'],
    Windows: ['~\\go\\pkg\\mod', '~\\AppData\\Local\\go-build'],
  },
};

const NODE_MODULES = '!**/node_modules/**';
const EXPECTED_LOCKFILES: Record<string, string[]> = {
  npm: ['**/package-lock.json', '**/npm-shrinkwrap.json', NODE_MODULES],
  yarn: ['**/yarn.lock', NODE_MODULES],
  pnpm: ['**/pnpm-lock.yaml', NODE_MODULES],
  bun: ['**/bun.lock', '**/bun.lockb', NODE_MODULES],
  pip: ['**/requirements.txt'],
  poetry: ['**/poetry.lock'],
  uv: [
    '**/*requirements*.txt',
    '**/*requirements*.in',
    '**/*constraints*.txt',
    '**/*constraints*.in',
    '**/pyproject.toml',
    '**/uv.lock',
    '**/*.py.lock',
  ],
  gradle: [
    '**/*.gradle*',
    '**/gradle.properties',
    '**/gradle-wrapper.properties',
    'buildSrc/**/Versions.kt',
    'buildSrc/**/Dependencies.kt',
    'gradle/*.versions.toml',
    '**/versions.properties',
  ],
  maven: ['**/pom.xml', '**/.mvn/wrapper/maven-wrapper.properties', '**/.mvn/extensions.xml'],
  cargo: ['**/Cargo.lock'],
  go: ['**/go.sum'],
};

beforeEach(() => {
  inputs.clear();
  mockInfo.mockReset();
});

describe('preset definitions', () => {
  it('offer exactly the eleven documented presets', () => {
    expect([...PRESET_NAMES].sort()).toEqual(Object.keys(EXPECTED_PATHS).sort());
  });

  it.each(Object.keys(EXPECTED_LOCKFILES))('%s hashes the documented lockfiles', (name) => {
    expect(PRESETS[name as keyof typeof PRESETS].lockfiles).toEqual(EXPECTED_LOCKFILES[name]);
  });
});

describe('applyPreset', () => {
  const cases = Object.entries(EXPECTED_PATHS).flatMap(([name, byOs]) =>
    (Object.keys(byOs) as Os[]).map((os) => [name, os] as const)
  );

  it.each(cases)('%s on %s resolves the path, key and restore-keys', async (name, os) => {
    const hash = fakeHash();
    const workspace = os === 'Windows' ? 'D:\\a\\repo\\repo' : '/home/runner/work/repo/repo';
    const resolved = await applyPreset(base, readPreset(name), { os, workspace, hash });

    expect(resolved.paths).toEqual(EXPECTED_PATHS[name][os]);
    expect(resolved.primaryKey).toBe(`${os}-${name}-abc123`);
    expect(resolved.restoreKeys).toEqual([`${os}-${name}-`]);
    expect(resolved.preset).toBe(name);
    expect(hash).toHaveBeenCalledTimes(1);
    const [patterns, hashedWorkspace] = hash.mock.calls[0];
    expect(hashedWorkspace).toBe(workspace);
    // Every lockfile glob is anchored at the workspace, so the result does not depend on the
    // current directory of the step.
    const lines = patterns.split('\n');
    expect(lines).toHaveLength(EXPECTED_LOCKFILES[name].length);
    for (const line of lines) {
      expect(line.replace(/^!/, '').startsWith(workspace)).toBe(true);
    }
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining(`${os}-${name}-abc123`));
  });

  it('returns the config unchanged without a preset', async () => {
    const hash = fakeHash();
    const config = { ...base, primaryKey: 'k', paths: ['dist'] };
    await expect(applyPreset(config, undefined, { os: 'Linux', hash })).resolves.toBe(config);
    expect(hash).not.toHaveBeenCalled();
  });

  it('uses an explicit path instead of the preset path, and still hashes the key', async () => {
    const config = { ...base, paths: ['custom/npm-cache'] };
    const resolved = await applyPreset(config, 'npm', { os: 'Linux', hash: fakeHash() });
    expect(resolved.paths).toEqual(['custom/npm-cache']);
    expect(resolved.primaryKey).toBe('Linux-npm-abc123');
    expect(resolved.restoreKeys).toEqual(['Linux-npm-']);
  });

  it('uses an explicit key verbatim, does not hash, and adds no preset restore-keys', async () => {
    const hash = fakeHash();
    const config = { ...base, primaryKey: 'my-key' };
    const resolved = await applyPreset(config, 'npm', { os: 'Linux', hash });
    expect(resolved.primaryKey).toBe('my-key');
    expect(resolved.restoreKeys).toEqual([]);
    expect(resolved.paths).toEqual(['~/.npm']);
    expect(hash).not.toHaveBeenCalled();
  });

  it('uses explicit restore-keys with the preset key', async () => {
    const config = { ...base, restoreKeys: ['Linux-npm-v2-'] };
    const resolved = await applyPreset(config, 'npm', { os: 'Linux', hash: fakeHash() });
    expect(resolved.primaryKey).toBe('Linux-npm-abc123');
    expect(resolved.restoreKeys).toEqual(['Linux-npm-v2-']);
  });

  it('fails with the globs named when no lockfile matches', async () => {
    await expect(
      applyPreset(base, 'cargo', { os: 'Linux', workspace: '/w', hash: fakeHash('') })
    ).rejects.toThrow(
      'Preset "cargo" found no lockfile to hash in /w. It looked for: **/Cargo.lock. Add a lockfile, or set the key input.'
    );
  });

  it('hashes real lockfiles with @actions/glob, relative to the workspace', async () => {
    const workspace = makeTempDir('preset');
    try {
      writeFiles(workspace, {
        'package-lock.json': '{"lockfileVersion":3}',
        'node_modules/dep/package-lock.json': 'ignored',
      });
      const resolved = await applyPreset(base, 'npm', { os: 'Linux', workspace });
      // hashFiles hashes the sha256 of each file, in order, into one sha256.
      const fileHash = createHash('sha256').update('{"lockfileVersion":3}').digest();
      const expected = createHash('sha256').update(fileHash).digest('hex');
      expect(resolved.primaryKey).toBe(`Linux-npm-${expected}`);
    } finally {
      removeDir(workspace);
    }
  });

  it('fails on a real workspace that has no lockfile', async () => {
    const workspace = makeTempDir('preset-empty');
    try {
      writeFiles(workspace, { 'README.md': 'x' });
      await expect(applyPreset(base, 'go', { os: 'Linux', workspace })).rejects.toThrow(
        `Preset "go" found no lockfile to hash in ${workspace}. It looked for: **/go.sum.`
      );
    } finally {
      removeDir(workspace);
    }
  });
});

describe('preset paths in the archive', () => {
  const itPosix = isWindows ? it.skip : it;

  itPosix('poetry archives the package caches and not the virtualenvs', async () => {
    const home = makeTempDir('preset-home');
    const workspace = makeTempDir('preset-ws');
    const restoreEnv = setEnv({ HOME: home });
    try {
      writeFiles(home, {
        '.cache/pypoetry/cache/repositories/PyPI/_http/a': 'http',
        '.cache/pypoetry/artifacts/ab/cd/pkg.whl': 'wheel',
        '.cache/pypoetry/virtualenvs/app-py3.12/pyvenv.cfg': 'venv',
      });
      const { entries } = await resolveCachePaths(PRESETS.poetry.paths.Linux, workspace);
      expect(entries).toHaveLength(2);
      expect(entries.some((e) => e.endsWith('.cache/pypoetry/cache'))).toBe(true);
      expect(entries.some((e) => e.endsWith('.cache/pypoetry/artifacts'))).toBe(true);
      expect(entries.filter((e) => e.includes('virtualenvs'))).toEqual([]);
      expect(entries.filter((e) => e.endsWith('.cache/pypoetry'))).toEqual([]);
    } finally {
      restoreEnv();
      removeDir(home);
      removeDir(workspace);
    }
  });
});

describe('readPreset', () => {
  it('reads the preset input, trimmed', () => {
    inputs.set(Inputs.Preset, ' pip ');
    expect(readPreset()).toBe('pip');
  });

  it('gives undefined for an empty input', () => {
    expect(readPreset()).toBeUndefined();
  });

  it('fails on an unknown preset and lists the valid ones', () => {
    expect(() => readPreset('npmm')).toThrow(
      'Input "preset" must be one of npm, yarn, pnpm, bun, pip, poetry, uv, gradle, maven, cargo, go; got "npmm".'
    );
  });
});

describe('runnerOs', () => {
  it('reads RUNNER_OS', () => {
    expect(runnerOs({ RUNNER_OS: 'macOS' }, 'linux')).toBe('macOS');
    expect(runnerOs({ RUNNER_OS: 'Windows' }, 'linux')).toBe('Windows');
    expect(runnerOs({ RUNNER_OS: 'Linux' }, 'darwin')).toBe('Linux');
  });

  it('falls back to the platform when RUNNER_OS is not set or not known', () => {
    expect(runnerOs({}, 'win32')).toBe('Windows');
    expect(runnerOs({}, 'darwin')).toBe('macOS');
    expect(runnerOs({ RUNNER_OS: 'Plan9' }, 'linux')).toBe('Linux');
  });
});
