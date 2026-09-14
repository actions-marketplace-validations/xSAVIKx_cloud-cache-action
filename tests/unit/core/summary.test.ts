import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import { makeTempDir, removeDir, setEnv } from '../../support/tempTree';
import { writeRestoreSummary, writeSaveSummary } from '../../../src/core/summary';

describe('writeRestoreSummary / writeSaveSummary', () => {
  let dir: string;
  let summaryFile: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    dir = makeTempDir('summary');
    summaryFile = path.join(dir, 'step-summary.md');
    fs.writeFileSync(summaryFile, '');
    restoreEnv = setEnv({ GITHUB_STEP_SUMMARY: summaryFile });
    // core.summary is a singleton that caches the resolved file path on first use; reset it so
    // each test's own temp file is picked up instead of a previous test's (now-deleted) one.
    (core.summary as unknown as { _filePath?: string })._filePath = undefined;
  });

  afterEach(() => {
    restoreEnv();
    removeDir(dir);
  });

  it('writes the restore table with the expected cells', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      matchedKey: 'Linux-npm-old',
      cacheHit: false,
      source: 's3',
      size: 2048,
      durationMs: 1240,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('Cloud cache restore');
    expect(content).toContain('Primary key');
    expect(content).toContain('Linux-npm-abc');
    expect(content).toContain('Matched key');
    expect(content).toContain('Linux-npm-old');
    expect(content).toContain('Cache hit');
    expect(content).toContain('false');
    expect(content).toContain('Source');
    expect(content).toContain('s3');
    expect(content).toContain('Size');
    expect(content).toContain('2.00 KB');
    expect(content).toContain('Duration');
    expect(content).toContain('1.24 s');
  });

  it('renders — for a missing matched key and size on a restore miss', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'Linux-npm-abc',
      cacheHit: false,
      source: 'none',
      durationMs: 500,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('—');
    expect(content).toContain('none');
    expect(content).toContain('0.50 s');
  });

  it('writes the save table with the expected cells', async () => {
    await writeSaveSummary({
      jobSummary: true,
      key: 'Linux-npm-abc',
      savedTo: ['s3', 'github'],
      size: 4096,
      durationMs: 2000,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('Cloud cache save');
    expect(content).toContain('Key');
    expect(content).toContain('Linux-npm-abc');
    expect(content).toContain('Saved to');
    expect(content).toContain('s3, github');
    expect(content).toContain('Size');
    expect(content).toContain('4.00 KB');
    expect(content).toContain('Duration');
    expect(content).toContain('2.00 s');
  });

  it('shows none when nothing was saved', async () => {
    await writeSaveSummary({
      jobSummary: true,
      key: 'Linux-npm-abc',
      savedTo: [],
      durationMs: 100,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('none');
  });

  it('writes nothing when job-summary is false', async () => {
    await writeRestoreSummary({
      jobSummary: false,
      primaryKey: 'Linux-npm-abc',
      cacheHit: false,
      source: 'none',
      durationMs: 100,
    });

    expect(fs.readFileSync(summaryFile, 'utf8')).toBe('');
  });

  it('writes nothing when GITHUB_STEP_SUMMARY is unset', async () => {
    restoreEnv();
    restoreEnv = setEnv({ GITHUB_STEP_SUMMARY: undefined });

    await expect(
      writeSaveSummary({
        jobSummary: true,
        key: 'Linux-npm-abc',
        savedTo: ['s3'],
        durationMs: 100,
      })
    ).resolves.toBeUndefined();

    expect(fs.readFileSync(summaryFile, 'utf8')).toBe('');
  });

  it('swallows a write failure instead of throwing', async () => {
    restoreEnv();
    const missingPath = path.join(dir, 'no-such-dir', 'step-summary.md');
    restoreEnv = setEnv({ GITHUB_STEP_SUMMARY: missingPath });

    await expect(
      writeRestoreSummary({
        jobSummary: true,
        primaryKey: 'Linux-npm-abc',
        cacheHit: false,
        source: 'none',
        durationMs: 100,
      })
    ).resolves.toBeUndefined();

    expect(fs.existsSync(missingPath)).toBe(false);
  });

  it('HTML-escapes keys in the restore table, so a key cannot break the markup', async () => {
    await writeRestoreSummary({
      jobSummary: true,
      primaryKey: 'a<b>&c',
      matchedKey: 'x"<td>y',
      cacheHit: true,
      source: 's3',
      durationMs: 100,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<td>a&lt;b&gt;&amp;c</td>');
    expect(content).toContain('<td>x&quot;&lt;td&gt;y</td>');
    expect(content).not.toContain('a<b>');
    expect(content).not.toContain('<td>y');
  });

  it('HTML-escapes the key in the save table', async () => {
    await writeSaveSummary({
      jobSummary: true,
      key: 'a<b>&c',
      savedTo: ['s3'],
      durationMs: 100,
    });

    const content = fs.readFileSync(summaryFile, 'utf8');
    expect(content).toContain('<td>a&lt;b&gt;&amp;c</td>');
    expect(content).not.toContain('a<b>');
  });
});
