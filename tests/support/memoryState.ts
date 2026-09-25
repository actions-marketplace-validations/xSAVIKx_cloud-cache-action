import { State } from '../../src/constants';
import type { IStateProvider } from '../../src/state';

/** IStateProvider backed by a Map, standing in for GITHUB_STATE in tests. */
export class MemoryState implements IStateProvider {
  readonly values = new Map<string, string>();

  getState(key: string): string {
    return this.values.get(key) ?? '';
  }

  setState(key: string, value: string): void {
    this.values.set(key, value);
  }

  getCacheState(): string {
    return this.getState(State.CacheMatchedKey);
  }
}
