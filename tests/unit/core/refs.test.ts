import { resolveRefCandidates } from '../../../src/core/refs';

const events: Record<string, string> = {
  '/event/main.json': JSON.stringify({ repository: { default_branch: 'main' } }),
  '/event/none.json': JSON.stringify({}),
  '/event/bad.json': '{not json',
};

const readFile = (file: string): string => {
  const content = events[file];
  if (content === undefined) {
    throw new Error(`ENOENT: ${file}`);
  }
  return content;
};

describe('resolveRefCandidates', () => {
  it('disables ref scoping when GITHUB_REF is not set', () => {
    expect(resolveRefCandidates({}, readFile)).toEqual({ current: undefined, restore: [] });
  });

  it('searches the current ref, then the default branch', () => {
    expect(
      resolveRefCandidates(
        { GITHUB_REF: 'refs/heads/feature', GITHUB_EVENT_PATH: '/event/main.json' },
        readFile
      )
    ).toEqual({
      current: 'refs/heads/feature',
      restore: ['refs/heads/feature', 'refs/heads/main'],
    });
  });

  it('searches a pull request merge ref, its base branch, then the default branch', () => {
    expect(
      resolveRefCandidates(
        {
          GITHUB_REF: 'refs/pull/7/merge',
          GITHUB_BASE_REF: 'release',
          GITHUB_EVENT_PATH: '/event/main.json',
        },
        readFile
      ).restore
    ).toEqual(['refs/pull/7/merge', 'refs/heads/release', 'refs/heads/main']);
  });

  it('does not repeat the default branch when running on it', () => {
    expect(
      resolveRefCandidates(
        { GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: '/event/main.json' },
        readFile
      ).restore
    ).toEqual(['refs/heads/main']);
  });

  it('does not repeat a base branch that is also the default branch', () => {
    expect(
      resolveRefCandidates(
        {
          GITHUB_REF: 'refs/pull/7/merge',
          GITHUB_BASE_REF: 'main',
          GITHUB_EVENT_PATH: '/event/main.json',
        },
        readFile
      ).restore
    ).toEqual(['refs/pull/7/merge', 'refs/heads/main']);
  });

  it.each(['/event/none.json', '/event/bad.json', '/event/missing.json'])(
    'ignores an unusable event payload at %s',
    (eventPath) => {
      expect(
        resolveRefCandidates(
          { GITHUB_REF: 'refs/heads/feature', GITHUB_EVENT_PATH: eventPath },
          readFile
        ).restore
      ).toEqual(['refs/heads/feature']);
    }
  );

  it('treats tags like any other ref', () => {
    expect(
      resolveRefCandidates(
        { GITHUB_REF: 'refs/tags/v1.1.0', GITHUB_EVENT_PATH: '/event/main.json' },
        readFile
      ).restore
    ).toEqual(['refs/tags/v1.1.0', 'refs/heads/main']);
  });
});
