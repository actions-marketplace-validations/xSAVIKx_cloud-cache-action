import {
  compileKeyTemplate,
  encodeRef,
  normalizePrefix,
  type KeyTemplateOptions,
} from '../../../src/core/keyTemplate';

const PATTERN = '${GITHUB_REPOSITORY}/${prefix}${ref}/${key}/${version}/${archive_filename}';
const VERSION = '27747e0d22df7792';
const MAIN = 'refs/heads/main';
const base: KeyTemplateOptions = {
  pattern: PATTERN,
  repository: 'octo/app',
  prefix: '',
  scopedToRepository: true,
  scopedToRef: true,
  version: VERSION,
  archiveFilename: 'cache.tar.zst',
  env: {},
};

describe('compileKeyTemplate', () => {
  it('builds the default object key', () => {
    expect(compileKeyTemplate(base).objectKey(MAIN, 'Linux-npm-abc')).toBe(
      `octo/app/refs%2Fheads%2Fmain/Linux-npm-abc/${VERSION}/cache.tar.zst`
    );
  });

  it('places a normalised prefix before the ref', () => {
    const template = compileKeyTemplate({ ...base, prefix: '\\web//app' });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `octo/app/web/app/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('drops the repository when scoped-to-repository is false', () => {
    const template = compileKeyTemplate({ ...base, scopedToRepository: false });
    expect(template.objectKey(MAIN, 'k')).toBe(`refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`);
  });

  it('drops the ref when scoped-to-ref is false', () => {
    const template = compileKeyTemplate({ ...base, scopedToRef: false });
    expect(template.objectKey('', 'k')).toBe(`octo/app/k/${VERSION}/cache.tar.zst`);
    expect(template.objectKey(MAIN, 'k')).toBe(`octo/app/k/${VERSION}/cache.tar.zst`);
    expect(template.warnings).toEqual([]);
  });

  it('encodes a ref as a single path segment', () => {
    expect(encodeRef('refs/pull/12/merge')).toBe('refs%2Fpull%2F12%2Fmerge');
  });

  it('inserts keys verbatim and reads them back, even with slashes and dollar signs', () => {
    const template = compileKeyTemplate({ ...base, env: { HOME: '/home/runner' } });
    const key = 'Linux/node-20/$HOME-${HOME}';
    const objectKey = template.objectKey(MAIN, key);
    expect(objectKey).toBe(`octo/app/refs%2Fheads%2Fmain/${key}/${VERSION}/cache.tar.zst`);
    expect(template.extractKey(MAIN, objectKey)).toBe(key);
  });

  it('expands environment references in the pattern', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern:
        '${GITHUB_REPOSITORY}/${RUNNER_OS}/$WORKLOAD/${env.JOB}/${ref}/${key}/${version}/${archive_filename}',
      env: { RUNNER_OS: 'Linux', WORKLOAD: 'api', JOB: 'build' },
    });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `octo/app/Linux/api/build/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('empties an unset braced variable and keeps an unset bare one literal', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${MISSING}/$ALSO_MISSING/${ref}/${key}/${version}/${archive_filename}',
    });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `$ALSO_MISSING/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('never expands an environment value a second time', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${A}/${ref}/${key}/${version}/${archive_filename}',
      env: { A: '$B', B: 'nope' },
    });
    expect(template.objectKey(MAIN, 'k')).toBe(`$B/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`);
  });

  it.each([
    ['${ref}/${archive_filename}', 0],
    ['${key}/${key}/${archive_filename}', 2],
  ])('rejects %s', (pattern, count) => {
    expect(() => compileKeyTemplate({ ...base, pattern })).toThrow(
      `s3-key-pattern must contain \${key} exactly once (found ${count})`
    );
  });

  it('warns when the pattern can scope by neither ref nor version', () => {
    const template = compileKeyTemplate({ ...base, pattern: '${key}/${archive_filename}' });
    expect(template.warnings).toEqual([
      expect.stringContaining('${ref}'),
      expect.stringContaining('${version}'),
    ]);
  });

  it('builds search prefixes that end in the key prefix', () => {
    expect(compileKeyTemplate(base).searchPrefix(MAIN, 'Linux-npm-')).toBe(
      'octo/app/refs%2Fheads%2Fmain/Linux-npm-'
    );
  });

  describe('extractKey', () => {
    const template = compileKeyTemplate(base);
    const root = 'octo/app/refs%2Fheads%2Fmain';

    it('returns the key of an object that matches the template', () => {
      expect(template.extractKey(MAIN, `${root}/Linux-npm-abc/${VERSION}/cache.tar.zst`)).toBe(
        'Linux-npm-abc'
      );
    });

    it.each([
      ['another version', `${root}/k/ffffffffffffffff/cache.tar.zst`],
      ['another archive format', `${root}/k/${VERSION}/cache.tar.gz`],
      ['another ref', `octo/app/refs%2Fheads%2Ffeature/k/${VERSION}/cache.tar.zst`],
      ['an empty key', `${root}//${VERSION}/cache.tar.zst`],
    ])('rejects an object with %s', (_label, objectKey) => {
      expect(template.extractKey(MAIN, objectKey)).toBeUndefined();
    });
  });
});

describe('normalizePrefix', () => {
  it.each([
    ['', ''],
    ['a', 'a/'],
    ['/a/b/', 'a/b/'],
    ['\\a\\b', 'a/b/'],
  ])('normalises "%s" to "%s"', (input, expected) => {
    expect(normalizePrefix(input)).toBe(expected);
  });
});
