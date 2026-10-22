import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The benchmark workflow runs tests/ci scripts with native Node type stripping, not with jest.
// Under native Node, a relative import without an extension fails with ERR_MODULE_NOT_FOUND.
// These tests start Node the same way, so such an import fails here and not only in CI.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function runNode(args: string[], env: NodeJS.ProcessEnv = {}) {
  const { BENCH_FIXTURES: _fixtures, GITHUB_STEP_SUMMARY: _summary, ...inherited } = process.env;
  return spawnSync(process.execPath, args, {
    cwd: REPO,
    env: { ...inherited, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('modules that native Node loads', () => {
  it('imports src/archive/commands.ts', () => {
    const url = pathToFileURL(path.join(REPO, 'src/archive/commands.ts')).href;
    const result = runNode([
      '--input-type=module',
      '-e',
      `const m = await import(${JSON.stringify(url)}); console.log(typeof m.buildCreateCommands);`,
    ]);
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('function');
  });

  it('loads the imports of tests/ci/compressionBenchmark.ts', () => {
    // Without BENCH_FIXTURES, the script stops after its imports load, before it does any work.
    const result = runNode(['tests/ci/compressionBenchmark.ts']);
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stderr).toContain('BENCH_FIXTURES is required');
  });
});
