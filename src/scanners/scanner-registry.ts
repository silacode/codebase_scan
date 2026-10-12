import { npmDependencies } from './npm-dependency-scanner.ts';
import type { ScannerAdapter } from './scanner-types.ts';
/** Every registered scanner; the worker runs all of them per scan. */
export const adapters: ScannerAdapter[] = [npmDependencies];
