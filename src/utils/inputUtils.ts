import * as core from '@actions/core';
import { Events } from '../constants';

export function getInputAsArray(name: string, options?: core.InputOptions): string[] {
  return core
    .getInput(name, options)
    .split('\n')
    .map((s) => s.trim())
    .filter((x) => x !== '');
}

export function getInputAsBool(
  name: string,
  defaultValue = false,
  options?: core.InputOptions
): boolean {
  const value = core.getInput(name, options);
  if (!value) {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

export function getInputAsInt(
  name: string,
  defaultValue?: number,
  options?: core.InputOptions
): number | undefined {
  const value = core.getInput(name, options);
  if (!value) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }
  return parsed;
}

export function getInputWithEnv(
  inputName: string,
  envVarNames: string[] = [],
  camelCaseInputName?: string
): string {
  // Check primary input
  let value = core.getInput(inputName);
  if (value) {
    return value;
  }

  // Check camelCase alias if provided
  if (camelCaseInputName) {
    value = core.getInput(camelCaseInputName);
    if (value) {
      return value;
    }
  }

  // Check environment variables
  for (const envVar of envVarNames) {
    const envVal = process.env[envVar];
    if (envVal !== undefined && envVal !== '') {
      return envVal;
    }
  }

  return '';
}

export function isExactKeyMatch(primaryKey: string, matchedKey?: string): boolean {
  if (!matchedKey) {
    return false;
  }
  return primaryKey.trim().toLowerCase() === matchedKey.trim().toLowerCase();
}

export function isValidEvent(): boolean {
  const event = process.env[Events.Key];
  // GitHub Actions events that are not tied to a ref (e.g. issues, discussion) might not be appropriate for caching
  // actions/cache warns if event is not ref-based, but allows execution
  return Boolean(event);
}

export function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) {
    return '0 B';
  }
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const unitIndex = Math.min(i, units.length - 1);
  const size = (bytes / Math.pow(1024, unitIndex)).toFixed(2);
  return `${size} ${units[unitIndex]}`;
}
