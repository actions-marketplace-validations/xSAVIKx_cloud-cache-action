import * as core from '@actions/core';
import { State } from './constants';

export interface IStateProvider {
  getState(key: string): string;
  setState(key: string, value: string): void;
  getCacheState(): string;
}

export class StateProvider implements IStateProvider {
  getState(key: string): string {
    return core.getState(key);
  }

  setState(key: string, value: string): void {
    core.saveState(key, value);
  }

  getCacheState(): string {
    return this.getState(State.CacheMatchedKey);
  }
}

export class NullStateProvider implements IStateProvider {
  private state: Map<string, string> = new Map();

  getState(key: string): string {
    return this.state.get(key) || '';
  }

  setState(key: string, value: string): void {
    this.state.set(key, value);
  }

  getCacheState(): string {
    return this.getState(State.CacheMatchedKey);
  }
}
