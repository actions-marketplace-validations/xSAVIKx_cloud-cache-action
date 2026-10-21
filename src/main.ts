// The one ncc bundle in dist/lib exports these functions. Importing it runs no action.
// Each dist/<action>/index.js entry calls one function. scripts/writeEntries.ts writes them.
export { runInspect } from './core/inspectImpl';
export { runPrune } from './core/pruneImpl';
export { runRestore, runRestoreOnly } from './core/restoreImpl';
export { runSave, runSaveOnly } from './core/saveImpl';
