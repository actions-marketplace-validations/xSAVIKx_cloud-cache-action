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

describe('placeholder removal', () => {
  it('removes ${GITHUB_REPOSITORY} and ${ref} cleanly when they are not slash-adjacent on both sides', () => {
    const pattern = 'builds/${GITHUB_REPOSITORY}-${ref}/${key}/${version}/${archive_filename}';

    expect(
      compileKeyTemplate({
        ...base,
        pattern,
        scopedToRepository: true,
        scopedToRef: true,
      }).objectKey(MAIN, 'k')
    ).toBe(`builds/octo/app-refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`);

    expect(
      compileKeyTemplate({
        ...base,
        pattern,
        scopedToRepository: false,
        scopedToRef: true,
      }).objectKey(MAIN, 'k')
    ).toBe(`builds-refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`);

    expect(
      compileKeyTemplate({
        ...base,
        pattern,
        scopedToRepository: true,
        scopedToRef: false,
      }).objectKey('', 'k')
    ).toBe(`builds/octo/app-k/${VERSION}/cache.tar.zst`);

    expect(
      compileKeyTemplate({
        ...base,
        pattern,
        scopedToRepository: false,
        scopedToRef: false,
      }).objectKey('', 'k')
    ).toBe(`builds-k/${VERSION}/cache.tar.zst`);
  });

  it('never leaves a leading slash when ${ref} opens the pattern', () => {
    const pattern = '${ref}/${key}';

    expect(compileKeyTemplate({ ...base, pattern, scopedToRef: true }).objectKey(MAIN, 'k')).toBe(
      `refs%2Fheads%2Fmain/k`
    );
    expect(compileKeyTemplate({ ...base, pattern, scopedToRef: false }).objectKey('', 'k')).toBe(
      'k'
    );
  });

  it('never leaves a doubled slash when ${ref} sits between ${key} and a following segment', () => {
    const pattern = '${key}/${ref}/${archive_filename}';

    expect(compileKeyTemplate({ ...base, pattern, scopedToRef: true }).objectKey(MAIN, 'k')).toBe(
      'k/refs%2Fheads%2Fmain/cache.tar.zst'
    );
    expect(compileKeyTemplate({ ...base, pattern, scopedToRef: false }).objectKey('', 'k')).toBe(
      'k/cache.tar.zst'
    );
  });

  it('drops ${ref} cleanly when it is glued to ${prefix} with no slash between them', () => {
    const pattern = '${prefix}${ref}/${key}/${archive_filename}';

    expect(
      compileKeyTemplate({ ...base, pattern, prefix: 'team-a', scopedToRef: true }).objectKey(
        MAIN,
        'k'
      )
    ).toBe('team-a/refs%2Fheads%2Fmain/k/cache.tar.zst');
    expect(
      compileKeyTemplate({ ...base, pattern, prefix: 'team-a', scopedToRef: false }).objectKey(
        '',
        'k'
      )
    ).toBe('team-a/k/cache.tar.zst');
  });
});

describe('bare special variables', () => {
  it('keeps a bare special variable literal instead of expanding it from the environment', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${GITHUB_REPOSITORY}/$ref/${key}/${version}/${archive_filename}',
      env: { ref: 'should-not-be-used' },
    });
    expect(template.objectKey(MAIN, 'k')).toBe(`octo/app/$ref/k/${VERSION}/cache.tar.zst`);
  });

  it('never substitutes a bare ${GITHUB_REPOSITORY}, even though the real env var is set', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '$GITHUB_REPOSITORY/${ref}/${key}/${version}/${archive_filename}',
      env: { GITHUB_REPOSITORY: 'someone/else' },
    });
    expect(template.objectKey(MAIN, 'k')).toBe(
      `$GITHUB_REPOSITORY/refs%2Fheads%2Fmain/k/${VERSION}/cache.tar.zst`
    );
  });

  it('warns once per distinct bare special variable', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${ref}/$key/${key}/$ref/${version}/${archive_filename}',
    });
    expect(template.warnings).toEqual([
      's3-key-pattern uses $key; write ${key} to use the key placeholder.',
      's3-key-pattern uses $ref; write ${ref} to use the ref placeholder.',
    ]);
  });

  it('does not warn about an ordinary bare environment reference', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '$RUNNER_OS/${ref}/${key}/${version}/${archive_filename}',
      env: { RUNNER_OS: 'Linux' },
    });
    expect(template.warnings).toEqual([]);
  });
});

describe('scopePrefix', () => {
  it('equals searchPrefix(ref, "") for a given ref', () => {
    const template = compileKeyTemplate(base);
    expect(template.scopePrefix(MAIN)).toBe(template.searchPrefix(MAIN, ''));
    expect(template.scopePrefix(MAIN)).toBe('octo/app/refs%2Fheads%2Fmain/');
  });

  it('resolves the text before ${ref} for every ref when no ref is given', () => {
    const template = compileKeyTemplate(base);
    expect(template.scopePrefix()).toBe('octo/app/');
  });

  it('equals searchPrefix("", "") for an unscoped pattern', () => {
    const template = compileKeyTemplate({ ...base, scopedToRef: false });
    expect(template.scopePrefix()).toBe(template.searchPrefix('', ''));
    expect(template.scopePrefix()).toBe('octo/app/');
    expect(template.scopePrefix(MAIN)).toBe(template.searchPrefix('', ''));
  });

  it('applies the same normalisation as the base for a custom pattern', () => {
    const template = compileKeyTemplate({
      ...base,
      pattern: '${prefix}${ref}/${key}/${archive_filename}',
      prefix: 'team-a',
    });
    expect(template.scopePrefix()).toBe('team-a/');
    expect(template.scopePrefix(MAIN)).toBe('team-a/refs%2Fheads%2Fmain/');
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
