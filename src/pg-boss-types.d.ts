import type { ConstructorOptions } from 'pg-boss';

declare module 'pg-boss/dist/types.js' {
  // pg-boss 12.37.1 omits these two public declarations from its published types.
  interface ResolvedConstructorOptions extends ConstructorOptions {}
  interface CommandResponse {
    affected: number;
  }
}
