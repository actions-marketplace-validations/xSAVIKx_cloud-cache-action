import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockExec = jest.fn<(cmd: string, args?: string[]) => Promise<number>>();
const mockWhich = jest.fn<(tool: string, check?: boolean) => Promise<string>>();
const mockDebug = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/exec', () => ({
  exec: mockExec,
}));

jest.unstable_mockModule('@actions/io', () => ({
  which: mockWhich,
}));

jest.unstable_mockModule('@actions/core', () => ({
  debug: mockDebug,
}));

const { createArchive, extractArchive, getArchiveSize } = await import('../../src/archive/tar');

describe('Archive Tar Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWhich.mockResolvedValue('/usr/bin/tar');
    mockExec.mockResolvedValue(0);
  });

  describe('createArchive', () => {
    it('creates a tar archive with zstd compression flags', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-test-'));
      const targetArchive = path.join(tempDir, 'output.tar.zst');

      try {
        await createArchive(
          targetArchive,
          ['src/index.ts', 'dist/index.js'],
          { method: 'zstd', archiveFilename: 'output.tar.zst' },
          false
        );

        expect(mockWhich).toHaveBeenCalledWith('tar', true);
        expect(mockExec).toHaveBeenCalledWith(
          '"/usr/bin/tar"',
          expect.arrayContaining([
            '--use-compress-program',
            'zstd -T0 -3',
            '-cf',
            targetArchive,
            '-P',
            '-T',
          ])
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('creates a tar archive with gzip compression flags', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-test-'));
      const targetArchive = path.join(tempDir, 'subdir', 'output.tar.gz');

      try {
        await createArchive(
          targetArchive,
          ['file1.txt', 'file2.txt'],
          { method: 'gzip', archiveFilename: 'output.tar.gz' },
          false
        );

        expect(mockExec).toHaveBeenCalledWith(
          '"/usr/bin/tar"',
          expect.arrayContaining(['-z', '-cf', targetArchive, '-P', '-T'])
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('normalizes Windows drive letters when enableCrossOsArchive is true', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-test-'));
      const targetArchive = path.join(tempDir, 'cross-os.tar.zst');
      let capturedManifestContent = '';

      mockExec.mockImplementationOnce(async (_cmd, args) => {
        if (args) {
          const manifestIndex = args.indexOf('-T');
          if (manifestIndex > -1) {
            const manifestPath = args[manifestIndex + 1];
            capturedManifestContent = fs.readFileSync(manifestPath, 'utf8');
          }
        }
        return 0;
      });

      try {
        await createArchive(
          targetArchive,
          ['C:\\Users\\runner\\workspace', 'D:/data/files'],
          { method: 'zstd', archiveFilename: 'cross-os.tar.zst' },
          true
        );

        expect(mockExec).toHaveBeenCalledTimes(1);
        expect(capturedManifestContent).toContain('/Users/runner/workspace');
        expect(capturedManifestContent).toContain('/data/files');
        expect(capturedManifestContent).not.toContain('C:');
        expect(capturedManifestContent).not.toContain('D:');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('extractArchive', () => {
    it('extracts zstd archive with correct flags and working directory', async () => {
      await extractArchive(
        '/tmp/cache.tar.zst',
        { method: 'zstd', archiveFilename: 'cache.tar.zst' },
        '/work/dir'
      );

      expect(mockWhich).toHaveBeenCalledWith('tar', true);
      expect(mockExec).toHaveBeenCalledWith('"/usr/bin/tar"', [
        '--use-compress-program',
        'zstd -d',
        '-xf',
        '/tmp/cache.tar.zst',
        '-P',
        '-C',
        '/work/dir',
      ]);
    });

    it('extracts gzip archive with default working directory', async () => {
      await extractArchive('/tmp/cache.tar.gz', {
        method: 'gzip',
        archiveFilename: 'cache.tar.gz',
      });

      expect(mockExec).toHaveBeenCalledWith('"/usr/bin/tar"', [
        '-z',
        '-xf',
        '/tmp/cache.tar.gz',
        '-P',
        '-C',
        process.cwd(),
      ]);
    });
  });

  describe('getArchiveSize', () => {
    it('returns accurate file size for existing file', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'size-test-'));
      const testFile = path.join(tempDir, 'test.bin');

      try {
        fs.writeFileSync(testFile, Buffer.alloc(2048));
        const size = getArchiveSize(testFile);
        expect(size).toBe(2048);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('returns 0 when file does not exist', () => {
      const size = getArchiveSize('/nonexistent/path/cache.tar.zst');
      expect(size).toBe(0);
    });
  });
});
