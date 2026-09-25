import { computeCacheVersion } from '../../../src/core/version';

describe('computeCacheVersion', () => {
  it('matches recorded values, so a layout change is always deliberate', () => {
    expect(computeCacheVersion(['~/.npm'], 'zstd', false, 'linux')).toBe('27747e0d22df7792');
    expect(computeCacheVersion(['~/.npm'], 'zstd', false, 'win32')).toBe('4703fa7037ae1017');
  });

  it('is 16 lowercase hex characters', () => {
    expect(computeCacheVersion(['node_modules'], 'gzip', false, 'linux')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores whitespace around patterns', () => {
    expect(computeCacheVersion([' node_modules '], 'gzip', false, 'linux')).toBe(
      computeCacheVersion(['node_modules'], 'gzip', false, 'linux')
    );
  });

  it('depends on pattern order and content', () => {
    const ab = computeCacheVersion(['a', 'b'], 'zstd', false, 'linux');
    expect(computeCacheVersion(['b', 'a'], 'zstd', false, 'linux')).not.toBe(ab);
    expect(computeCacheVersion(['a', 'c'], 'zstd', false, 'linux')).not.toBe(ab);
  });

  it('depends on the compression method', () => {
    expect(computeCacheVersion(['a'], 'zstd', false, 'linux')).not.toBe(
      computeCacheVersion(['a'], 'gzip', false, 'linux')
    );
  });

  it('marks Windows caches unless enableCrossOsArchive is set', () => {
    const linux = computeCacheVersion(['~/.npm'], 'zstd', false, 'linux');
    expect(computeCacheVersion(['~/.npm'], 'zstd', true, 'win32')).toBe(linux);
    expect(computeCacheVersion(['~/.npm'], 'zstd', false, 'win32')).not.toBe(linux);
    expect(computeCacheVersion(['~/.npm'], 'zstd', false, 'darwin')).toBe(linux);
    expect(computeCacheVersion(['~/.npm'], 'zstd', true, 'linux')).toBe(linux);
  });
});
