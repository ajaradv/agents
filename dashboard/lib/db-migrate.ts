import type { Database } from "bun:sqlite";

/**
 * Numbered schema migrations for the hub's SQLite files. `PRAGMA user_version`
 * is the record of what a file has: each migration with a higher version runs
 * in order, in its own transaction together with the version bump, so a
 * failure leaves the file at the last good version. Never edit an applied
 * migration; append the next version (docs/metrics.md).
 */
export type Migration = {
  version: number;
  /** SQL, or code for steps SQL cannot express (a column added only when missing). */
  up: string | ((db: Database) => void);
  note: string;
};

/** ALTER TABLE ... ADD COLUMN only when the table lacks it, so old files and new ones pass through alike. */
export function addColumn(db: Database, table: string, column: string, decl: string): void {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function migrate(db: Database, migrations: Migration[], name: string): { from: number; to: number; applied: number[] } {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`${name}: migrations must be numbered 1..n in order (found ${m.version} at position ${i + 1})`);
  });
  const from = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= from) continue;
    try {
      // The node and the dashboard open the same files at start: take the write lock first and read
      // the version again under it, so the second process finds the work done instead of redoing it.
      const ran = db.transaction(() => {
        if ((db.query("PRAGMA user_version").get() as { user_version: number }).user_version >= m.version) return false;
        if (typeof m.up === "string") db.exec(m.up);
        else m.up(db);
        db.exec(`PRAGMA user_version = ${m.version}`);
        return true;
      }).immediate();
      if (!ran) continue;
    } catch (e) {
      throw new Error(`${name}: migration ${m.version} (${m.note}) failed, database stays at version ${m.version - 1}: ${e instanceof Error ? e.message : e}`);
    }
    applied.push(m.version);
  }
  return { from, to: applied.at(-1) ?? from, applied };
}
