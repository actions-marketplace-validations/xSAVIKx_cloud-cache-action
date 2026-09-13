import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { Defaults, Inputs, Outputs } from '../../src/constants';

interface ManifestInput {
  description: string;
  required?: boolean;
  default?: string;
}

interface Manifest {
  inputs: Record<string, ManifestInput>;
  outputs: Record<string, { description: string }>;
  runs: { using: string; main: string; post?: string; 'post-if'?: string };
  branding: { icon: string; color: string };
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (relative: string): Manifest =>
  parse(readFileSync(path.join(REPO, relative), 'utf8')) as Manifest;

const root = load('action.yml');
const pruneManifest = load('prune/action.yml');
const subActions: Array<[string, Manifest]> = [
  ['restore/action.yml', load('restore/action.yml')],
  ['save/action.yml', load('save/action.yml')],
];
const allManifests: Array<[string, Manifest]> = [
  ['action.yml', root],
  ...subActions,
  ['prune/action.yml', pruneManifest],
];

// Inputs/outputs that exist only for the prune sub-action and are exempt from the root manifest.
const PRUNE_ONLY_INPUTS: string[] = [Inputs.OlderThanDays, Inputs.Ref, Inputs.DryRun];
const PRUNE_ONLY_OUTPUTS: string[] = [Outputs.PrunedCount, Outputs.PrunedBytes, Outputs.KeptCount];

describe('action manifests', () => {
  it('declare every input the code reads', () => {
    const missing = Object.values(Inputs)
      .filter((name) => !PRUNE_ONLY_INPUTS.includes(name))
      .filter((name) => !(name in root.inputs));
    expect(missing).toEqual([]);
  });

  it('do not declare inputs the code never reads', () => {
    const known = new Set<string>(Object.values(Inputs));
    for (const [file, manifest] of allManifests) {
      const unknown = Object.keys(manifest.inputs).filter((name) => !known.has(name));
      expect({ file, unknown }).toEqual({ file, unknown: [] });
    }
  });

  it('declare every output the code sets', () => {
    const missing = Object.values(Outputs)
      .filter((name) => !PRUNE_ONLY_OUTPUTS.includes(name))
      .filter((name) => !(name in root.outputs));
    expect(missing).toEqual([]);
  });

  it.each(subActions)('%s is a subset of the root manifest with the same defaults', (_file, m) => {
    for (const [name, input] of Object.entries(m.inputs)) {
      expect({ name, inRoot: name in root.inputs }).toEqual({ name, inRoot: true });
      expect({ name, default: input.default }).toEqual({
        name,
        default: root.inputs[name].default,
      });
    }
    for (const name of Object.keys(m.outputs)) {
      expect({ name, inRoot: name in root.outputs }).toEqual({ name, inRoot: true });
    }
  });

  it("prune/action.yml's shared inputs are a subset of the root manifest with the same defaults", () => {
    for (const [name, input] of Object.entries(pruneManifest.inputs)) {
      if (PRUNE_ONLY_INPUTS.includes(name)) {
        continue;
      }
      expect({ name, inRoot: name in root.inputs }).toEqual({ name, inRoot: true });
      expect({ name, default: input.default }).toEqual({
        name,
        default: root.inputs[name].default,
      });
    }
  });

  it.each(allManifests)('%s uses the defaults the code falls back to', (_file, manifest) => {
    const expectDefault = (name: string, value: string): void => {
      if (name in manifest.inputs) {
        expect({ name, default: manifest.inputs[name].default }).toEqual({ name, default: value });
      }
    };
    expectDefault(Inputs.S3KeyPattern, Defaults.DefaultS3KeyPattern);
    expectDefault(Inputs.RetryCount, String(Defaults.DefaultRetryCount));
    expectDefault(Inputs.RestorePriority, Defaults.DefaultRestorePriority);
    expectDefault(Inputs.DualCacheStrategy, Defaults.DefaultDualCacheStrategy);
  });

  it('no longer offers save-always, which post-if can never honour', () => {
    for (const [, manifest] of allManifests) {
      expect(Object.keys(manifest.inputs)).not.toContain('save-always');
    }
  });

  it('runs the bundled entrypoints on node24', () => {
    expect(root.runs).toEqual({
      using: 'node24',
      main: 'dist/restore/index.js',
      post: 'dist/save/index.js',
      'post-if': 'success()',
    });
    expect(subActions[0][1].runs).toEqual({
      using: 'node24',
      main: '../dist/restore-only/index.js',
    });
    expect(subActions[1][1].runs).toEqual({ using: 'node24', main: '../dist/save-only/index.js' });
    expect(pruneManifest.runs).toEqual({ using: 'node24', main: '../dist/prune/index.js' });
  });

  it.each(allManifests)('%s uses a valid Feather branding icon', (_file, manifest) => {
    const allowedIcons = ['cloud', 'upload-cloud', 'download-cloud', 'trash-2'];
    expect(allowedIcons).toContain(manifest.branding.icon);
  });
});
