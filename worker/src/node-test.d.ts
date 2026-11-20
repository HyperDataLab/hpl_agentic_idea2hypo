// The few Node APIs the tests use (testDb.ts). The worker itself is typed with @cloudflare/workers-types only.
declare module 'node:sqlite' {
  type Value = string | number | bigint | null | Uint8Array;
  interface StatementSync {
    all(...values: Value[]): unknown[];
    get(...values: Value[]): unknown;
    run(...values: Value[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
declare module 'node:fs' {
  export function readdirSync(path: URL | string): string[];
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
}
