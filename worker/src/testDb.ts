// Tests only: D1's API over Node's built-in SQLite, with the real migrations applied, so the SQL in store.ts
// runs against a real database without the Cloudflare runtime.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Database, Statement } from './store';

class SqliteStatement implements Statement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}
  bind(...values: unknown[]): Statement {
    return new SqliteStatement(this.db, this.query, values);
  }
  private params() {
    return this.values.map((value) => (value === undefined ? null : value)) as (string | number | null)[];
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.query).all(...this.params()) as T[] };
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.query).get(...this.params()) as T | undefined) ?? null;
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.db.prepare(this.query).run(...this.params());
    return { meta: { changes: Number(result.changes) } };
  }
  runSync() {
    this.db.prepare(this.query).run(...this.params());
  }
}

export function sqliteDatabase(): Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', (import.meta as unknown as { url: string }).url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort())
    raw.exec(readFileSync(new URL(file, dir), 'utf8'));
  return {
    raw,
    prepare: (query) => new SqliteStatement(raw, query),
    // D1 runs a batch as one transaction.
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        for (const statement of statements) (statement as SqliteStatement).runSync();
        raw.exec('COMMIT');
      } catch (error) {
        raw.exec('ROLLBACK');
        throw error;
      }
      return [];
    },
  };
}
