import type { FeatureSql, SupportFeature } from '../feature/types';

/** Core tables shared by all deployments. Features add columns via migrate(). */
export function applyCoreSchema(
  sql: FeatureSql,
  // Features are env-parameterized; schema only needs migrate().
  features: Array<Pick<SupportFeature, 'migrate'>>,
): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      slack_thread_ts TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      closed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      body TEXT,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      author_role TEXT NOT NULL,
      author_name TEXT,
      created_at INTEGER NOT NULL,
      client_id TEXT,
      slack_ts TEXT,
      reactions_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id
      ON messages(client_id) WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS messages_conversation
      ON messages(conversation_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS messages_slack_ts
      ON messages(slack_ts) WHERE slack_ts IS NOT NULL;
  `);

  // Idempotent column adds for DOs created before status/reactions existed.
  migrateColumns(sql, 'conversations', [
    { name: 'status', ddl: `ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'` },
    { name: 'closed_at', ddl: `ALTER TABLE conversations ADD COLUMN closed_at INTEGER` },
  ]);
  migrateColumns(sql, 'messages', [
    {
      name: 'reactions_json',
      ddl: `ALTER TABLE messages ADD COLUMN reactions_json TEXT NOT NULL DEFAULT '[]'`,
    },
  ]);

  for (const feature of features) {
    feature.migrate?.(sql);
  }
}

function migrateColumns(
  sql: FeatureSql,
  table: string,
  columns: Array<{ name: string; ddl: string }>,
): void {
  const cols = new Set(
    sql
      .exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((r) => r.name),
  );
  for (const col of columns) {
    if (!cols.has(col.name)) {
      sql.exec(col.ddl);
    }
  }
}
