import { jest } from '@jest/globals';

const mockWhich = jest.fn<(tool: string, check?: boolean) => Promise<string>>();
const mockDebug = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/io', () => ({
  which: mockWhich,
}));

jest.unstable_mockModule('@actions/core', () => ({
  debug: mockDebug,
}));

const { getCompressionConfig, resetCompressionConfigCache } =
  await import('../../src/archive/compression');

describe('Archive Compression Config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetCompressionConfigCache();
  });

  it('detects zstd when available on system PATH', async () => {
    mockWhich.mockResolvedValueOnce('/usr/bin/zstd');

    const config = await getCompressionConfig();

    expect(config.method).toBe('zstd');
    expect(config.archiveFilename).toBe('cache.tar.zst');
    expect(mockWhich).toHaveBeenCalledWith('zstd', false);
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('zstd binary found'));
  });

  it('reuses cached compression config on subsequent calls', async () => {
    mockWhich.mockResolvedValueOnce('/usr/bin/zstd');

    const first = await getCompressionConfig();
    const second = await getCompressionConfig();

    expect(first).toBe(second);
    expect(mockWhich).toHaveBeenCalledTimes(1);
  });

  it('falls back to gzip when zstd is not found', async () => {
    mockWhich.mockResolvedValueOnce('');

    const config = await getCompressionConfig();

    expect(config.method).toBe('gzip');
    expect(config.archiveFilename).toBe('cache.tar.gz');
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('falling back to gzip'));
  });

  it('falls back to gzip when which throws an error', async () => {
    mockWhich.mockRejectedValueOnce(new Error('Command not found'));

    const config = await getCompressionConfig();

    expect(config.method).toBe('gzip');
    expect(config.archiveFilename).toBe('cache.tar.gz');
    expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('zstd detection error'));
  });

  it('resetCompressionConfigCache resets the cache so detection runs again', async () => {
    mockWhich.mockResolvedValueOnce('/usr/bin/zstd');
    await getCompressionConfig();

    resetCompressionConfigCache();

    mockWhich.mockResolvedValueOnce('');
    const config2 = await getCompressionConfig();

    expect(config2.method).toBe('gzip');
    expect(mockWhich).toHaveBeenCalledTimes(2);
  });
});
