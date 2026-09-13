import { normalizeLinkTarget } from '../../support/fixtureTree';

describe('normalizeLinkTarget', () => {
  it('turns backslashes into forward slashes, as Windows symlink targets may use', () => {
    expect(normalizeLinkTarget('..\\..\\outside-target-does-not-exist')).toBe(
      '../../outside-target-does-not-exist'
    );
  });

  it('leaves forward-slash targets unchanged', () => {
    expect(normalizeLinkTarget('src/index.js')).toBe('src/index.js');
  });

  it('handles a mix of separators', () => {
    expect(normalizeLinkTarget('a\\b/c\\d')).toBe('a/b/c/d');
  });
});
