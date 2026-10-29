import { getCacheMode, isCacheReadable, isCacheWritable } from '../../../src/core/cacheMode';
import { setEnv } from '../../support/tempTree';

describe('cacheMode', () => {
  let restoreEnv: () => void = () => {};

  afterEach(() => {
    restoreEnv();
  });

  it.each([
    [undefined, ''],
    ['', ''],
    ['read', 'read'],
    ['  Write-Only \n', 'write-only'],
    ['NONE', 'none'],
  ])('reads ACTIONS_CACHE_MODE %p as %p', (value, expected) => {
    restoreEnv = setEnv({ ACTIONS_CACHE_MODE: value });
    expect(getCacheMode()).toBe(expected);
  });

  it.each([
    ['', true, true],
    ['write', true, true],
    ['read', true, false],
    ['write-only', false, true],
    ['none', false, false],
    ['readonly', true, true],
    ['off', true, true],
  ])('mode %p is readable %p and writable %p', (mode, readable, writable) => {
    expect(isCacheReadable(mode)).toBe(readable);
    expect(isCacheWritable(mode)).toBe(writable);
  });
});
