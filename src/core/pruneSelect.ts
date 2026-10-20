/** One archive that prune lists and may select for deletion. */
export interface PruneCandidate {
  key: string;
  size: number;
  lastModified?: Date;
  /** The ref segment of the key; '' when the key template has no ref segment. */
  group: string;
}

/** The rules that decide what prune deletes. Each rule is optional; at least one must be set. */
export interface PruneRules {
  /** Delete archives last modified more than this many days before `now`. */
  olderThanDays?: number;
  /** In each group, never delete the N most recently modified archives. */
  keepLatest?: number;
  /** After the other rules, delete the oldest remaining archives until the total fits. */
  maxTotalSize?: number;
}

export type PruneReason = 'age' | 'count' | 'size budget';

export interface Selection<T extends PruneCandidate> {
  object: T;
  reason: PruneReason;
}

export interface SelectionResult<T extends PruneCandidate> {
  selected: Array<Selection<T>>;
  /** Bytes still over the size budget after every eligible archive is selected; 0 when it fits. */
  overBudgetBytes: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function hasPruneRule(rules: PruneRules): boolean {
  return (
    rules.olderThanDays !== undefined ||
    rules.keepLatest !== undefined ||
    rules.maxTotalSize !== undefined
  );
}

/**
 * Chooses the archives to delete. An archive with no LastModified time is never selected and
 * always counts as protected, because its age is unknown.
 *
 * 1. The newest `keepLatest` archives of each group are protected.
 * 2. An unprotected archive is selected when it is older than `olderThanDays`. When that rule is
 *    not set but `keepLatest` is, every unprotected archive is selected (reason "count").
 * 3. If the remaining total is above `maxTotalSize`, the oldest unprotected archives are selected
 *    (reason "size budget") until the total fits or none is left.
 */
export function selectForPrune<T extends PruneCandidate>(
  candidates: readonly T[],
  rules: PruneRules,
  now: Date
): SelectionResult<T> {
  const byAge = (a: T, b: T): number =>
    (a.lastModified?.getTime() ?? 0) - (b.lastModified?.getTime() ?? 0) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  const protectedKeys = new Set<string>(
    candidates.filter((object) => object.lastModified === undefined).map((object) => object.key)
  );
  if (rules.keepLatest !== undefined) {
    const groups = new Map<string, T[]>();
    for (const object of candidates) {
      groups.set(object.group, [...(groups.get(object.group) ?? []), object]);
    }
    for (const members of groups.values()) {
      for (const object of members.sort((a, b) => byAge(b, a)).slice(0, rules.keepLatest)) {
        protectedKeys.add(object.key);
      }
    }
  }

  const selected: Array<Selection<T>> = [];
  const remaining: T[] = [];
  const cutoff =
    rules.olderThanDays === undefined ? undefined : now.getTime() - rules.olderThanDays * DAY_MS;
  for (const object of candidates) {
    const time = object.lastModified?.getTime();
    if (protectedKeys.has(object.key) || time === undefined) {
      remaining.push(object);
    } else if (cutoff !== undefined) {
      if (time < cutoff) {
        selected.push({ object, reason: 'age' });
      } else {
        remaining.push(object);
      }
    } else if (rules.keepLatest !== undefined) {
      selected.push({ object, reason: 'count' });
    } else {
      remaining.push(object);
    }
  }

  let overBudgetBytes = 0;
  if (rules.maxTotalSize !== undefined) {
    let total = remaining.reduce((sum, object) => sum + object.size, 0);
    const oldestFirst = remaining.filter((object) => !protectedKeys.has(object.key)).sort(byAge);
    for (const object of oldestFirst) {
      if (total <= rules.maxTotalSize) {
        break;
      }
      selected.push({ object, reason: 'size budget' });
      total -= object.size;
    }
    overBudgetBytes = Math.max(0, total - rules.maxTotalSize);
  }
  return { selected, overBudgetBytes };
}
