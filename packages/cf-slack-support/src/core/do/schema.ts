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
      updated_at INTEGER NOT NULL,
      external_adapter_id TEXT,
      external_inbox_id TEXT,
      external_location_id TEXT
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
      reactions_json TEXT NOT NULL DEFAULT '[]',
      external_adapter_id TEXT,
      external_message_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id
      ON messages(client_id) WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS messages_conversation
      ON messages(conversation_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS messages_slack_ts
      ON messages(slack_ts) WHERE slack_ts IS NOT NULL;
  `);

  // Idempotent column adds for DOs created before status/reactions/external existed.
  migrateColumns(sql, 'conversations', [
    { name: 'status', ddl: `ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'` },
    { name: 'closed_at', ddl: `ALTER TABLE conversations ADD COLUMN closed_at INTEGER` },
    { name: 'external_adapter_id', ddl: `ALTER TABLE conversations ADD COLUMN external_adapter_id TEXT` },
    { name: 'external_inbox_id', ddl: `ALTER TABLE conversations ADD COLUMN external_inbox_id TEXT` },
    { name: 'external_location_id', ddl: `ALTER TABLE conversations ADD COLUMN external_location_id TEXT` },
  ]);
  migrateColumns(sql, 'messages', [
    {
      name: 'reactions_json',
      ddl: `ALTER TABLE messages ADD COLUMN reactions_json TEXT NOT NULL DEFAULT '[]'`,
    },
    { name: 'external_adapter_id', ddl: `ALTER TABLE messages ADD COLUMN external_adapter_id TEXT` },
    { name: 'external_message_id', ddl: `ALTER TABLE messages ADD COLUMN external_message_id TEXT` },
  ]);

  // Indexes that reference migrated columns (IF NOT EXISTS is safe to re-run).
  sql.exec(`
    CREATE INDEX IF NOT EXISTS conversations_external_location
      ON conversations(external_adapter_id, external_location_id)
      WHERE external_location_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS messages_external_ref
      ON messages(external_adapter_id, external_message_id)
      WHERE external_message_id IS NOT NULL;
  `);

  // Backfill Slack bindings into external_* for rows created before this schema.
  sql.exec(`
    UPDATE conversations
    SET
      external_adapter_id = COALESCE(external_adapter_id, 'slack'),
      external_location_id = COALESCE(external_location_id, slack_thread_ts)
    WHERE slack_thread_ts IS NOT NULL
      AND (external_location_id IS NULL OR external_adapter_id IS NULL);
  `);
  sql.exec(`
    UPDATE messages
    SET
      external_adapter_id = COALESCE(external_adapter_id, 'slack'),
      external_message_id = COALESCE(external_message_id, slack_ts)
    WHERE slack_ts IS NOT NULL
      AND (external_message_id IS NULL OR external_adapter_id IS NULL);
  `);

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
