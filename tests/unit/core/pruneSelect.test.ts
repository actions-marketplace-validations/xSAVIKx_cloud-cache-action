import { hasPruneRule, selectForPrune, type PruneCandidate } from '../../../src/core/pruneSelect';

const NOW = new Date(Date.UTC(2026, 8, 13, 12, 0, 0));
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS);

function archive(
  key: string,
  group: string,
  size: number,
  age: number | undefined
): PruneCandidate {
  return {
    key,
    group,
    size,
    lastModified: age === undefined ? undefined : daysAgo(age),
  };
}

const summary = (result: ReturnType<typeof selectForPrune>): Array<[string, string]> =>
  result.selected.map(({ object, reason }): [string, string] => [object.key, reason]).sort();

describe('selectForPrune', () => {
  const objects = [
    archive('main-1', 'main', 100, 1),
    archive('main-2', 'main', 100, 10),
    archive('main-3', 'main', 100, 20),
    archive('dev-1', 'dev', 100, 15),
    archive('dev-2', 'dev', 100, 40),
  ];

  it('selects by age alone', () => {
    expect(summary(selectForPrune(objects, { olderThanDays: 12 }, NOW))).toEqual([
      ['dev-1', 'age'],
      ['dev-2', 'age'],
      ['main-3', 'age'],
    ]);
  });

  it('does not select an archive exactly at the age limit', () => {
    const edge = [archive('edge', 'r', 1, 12)];
    expect(selectForPrune(edge, { olderThanDays: 12 }, NOW).selected).toEqual([]);
  });

  it('protects the newest N of each ref from the age rule', () => {
    const result = selectForPrune(objects, { olderThanDays: 12, keepLatest: 1 }, NOW);
    expect(summary(result)).toEqual([
      ['dev-2', 'age'],
      ['main-3', 'age'],
    ]);
  });

  it('with keep-latest alone, selects everything beyond the newest N of each ref', () => {
    const result = selectForPrune(objects, { keepLatest: 2 }, NOW);
    expect(summary(result)).toEqual([['main-3', 'count']]);
    expect(summary(selectForPrune(objects, { keepLatest: 1 }, NOW))).toEqual([
      ['dev-2', 'count'],
      ['main-2', 'count'],
      ['main-3', 'count'],
    ]);
  });

  it('deletes the oldest archives of the whole scope until the budget fits', () => {
    const result = selectForPrune(objects, { maxTotalSize: 300 }, NOW);
    expect(summary(result)).toEqual([
      ['dev-2', 'size budget'],
      ['main-3', 'size budget'],
    ]);
    expect(result.overBudgetBytes).toBe(0);
  });

  it('counts only archives that remain after the age rule toward the budget', () => {
    const result = selectForPrune(objects, { olderThanDays: 30, maxTotalSize: 300 }, NOW);
    expect(summary(result)).toEqual([
      ['dev-2', 'age'],
      ['main-3', 'size budget'],
    ]);
  });

  it('never selects a keep-latest archive for the budget and reports the excess', () => {
    const result = selectForPrune(objects, { keepLatest: 1, maxTotalSize: 50 }, NOW);
    expect(summary(result)).toEqual([
      ['dev-2', 'size budget'],
      ['main-2', 'size budget'],
      ['main-3', 'size budget'],
    ]);
    expect(result.overBudgetBytes).toBe(150);
  });

  it('with keep-latest and a budget, only protects: nothing is deleted when the scope fits', () => {
    const result = selectForPrune(objects, { keepLatest: 1, maxTotalSize: 500 }, NOW);
    expect(result.selected).toEqual([]);
    expect(result.overBudgetBytes).toBe(0);
  });

  it('with keep-latest and a budget, deletes the oldest unprotected archives only as far as needed', () => {
    const result = selectForPrune(objects, { keepLatest: 1, maxTotalSize: 400 }, NOW);
    expect(summary(result)).toEqual([['dev-2', 'size budget']]);
  });

  it('accepts a budget of 0 and deletes every unprotected archive', () => {
    const result = selectForPrune(objects, { maxTotalSize: 0 }, NOW);
    expect(result.selected).toHaveLength(5);
    expect(selectForPrune(objects, { keepLatest: 1, maxTotalSize: 0 }, NOW).selected).toHaveLength(
      3
    );
  });

  it('selects nothing when the total already fits the budget', () => {
    const result = selectForPrune(objects, { maxTotalSize: 500 }, NOW);
    expect(result.selected).toEqual([]);
  });

  it('treats a budget of at least the total as met, even to the byte', () => {
    expect(selectForPrune(objects, { maxTotalSize: 500 }, NOW).selected).toHaveLength(0);
    expect(selectForPrune(objects, { maxTotalSize: 499 }, NOW).selected).toHaveLength(1);
  });

  it('breaks a modification-time tie by key, so the result is stable', () => {
    const tied = [archive('b', 'r', 10, 5), archive('a', 'r', 10, 5), archive('c', 'r', 10, 5)];
    expect(summary(selectForPrune(tied, { keepLatest: 1 }, NOW))).toEqual([
      ['a', 'count'],
      ['b', 'count'],
    ]);
  });

  it('never selects an archive with no modification time, but counts its size', () => {
    const unknown = [archive('unknown', 'r', 100, undefined), archive('old', 'r', 100, 50)];
    expect(summary(selectForPrune(unknown, { olderThanDays: 1 }, NOW))).toEqual([['old', 'age']]);
    const result = selectForPrune(unknown, { maxTotalSize: 50 }, NOW);
    expect(summary(result)).toEqual([['old', 'size budget']]);
    expect(result.overBudgetBytes).toBe(50);
  });

  it('treats one group as the whole scope when every archive has the same group', () => {
    const flat = objects.map((object) => ({ ...object, group: '' }));
    expect(summary(selectForPrune(flat, { keepLatest: 2 }, NOW))).toEqual([
      ['dev-1', 'count'],
      ['dev-2', 'count'],
      ['main-3', 'count'],
    ]);
  });
});

describe('the abort-uploads rule', () => {
  const files = [archive('a', 'r', 100, 50), archive('b', 'r', 100, 1)];

  it('counts as a rule on its own', () => {
    expect(hasPruneRule({ abortUploadsOlderThanHours: 24 })).toBe(true);
    expect(hasPruneRule({})).toBe(false);
  });

  it('selects no archive on its own', () => {
    const result = selectForPrune(files, { abortUploadsOlderThanHours: 24 }, NOW);
    expect(result.selected).toEqual([]);
    expect(result.overBudgetBytes).toBe(0);
  });

  it('does not stop keep-latest from deleting by count', () => {
    const result = selectForPrune(files, { keepLatest: 1, abortUploadsOlderThanHours: 24 }, NOW);
    expect(summary(result)).toEqual([['a', 'count']]);
  });
});
