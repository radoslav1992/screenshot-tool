/**
 * What each migration leaves behind in the database, so `/api/health` can say
 * which ones a deployment is missing.
 *
 * Production deploys from main before anyone applies the migration that came
 * with it, and pasting SQL into the D1 console leaves no record of what was
 * run. Looking the names up in `sqlite_master` is cheap and answers the
 * question directly. Every table, added column and index is listed, so a
 * console paste that stopped halfway reads as partly missing, not as applied.
 *
 * `scripts/schema-files-check.mjs` applies the migrations one at a time and
 * fails when this list and what they actually create disagree — including a
 * new migration that has no entry here yet.
 */

export interface MigrationManifest {
  /** The file in migrations/, which is also the name wrangler records in d1_migrations. */
  name: string;
  /** The schema every route has needed since the start; missing any of it means nothing works. */
  core?: boolean;
  /**
   * Every feature that needs it checks for it first and stays hidden until it
   * is there, so a deployment ahead of it still works. `/api/health` names it
   * without failing.
   */
  optional?: boolean;
  tables?: string[];
  /** Columns added to an existing table with ALTER TABLE, as `table.column`. */
  columns?: string[];
  indexes?: string[];
}

export const MIGRATIONS: MigrationManifest[] = [
  {
    name: '0001_init.sql',
    core: true,
    tables: ['users', 'sessions', 'api_keys', 'captures', 'usage_counters'],
    indexes: ['idx_sessions_user', 'idx_sessions_expires', 'idx_api_keys_user', 'idx_captures_user_created', 'idx_captures_user_mode'],
  },
  {
    name: '0002_verification_and_retention.sql',
    core: true,
    tables: ['email_verifications'],
    columns: ['users.email_verified_at'],
    indexes: ['idx_email_verifications_user', 'idx_email_verifications_expires', 'idx_captures_created'],
  },
  {
    name: '0003_billing.sql',
    core: true,
    tables: ['billing_events'],
    columns: [
      'users.stripe_customer_id',
      'users.stripe_subscription_id',
      'users.plan_status',
      'users.plan_period_end',
      'users.plan_interval',
    ],
    indexes: ['idx_users_stripe_customer', 'idx_billing_events_received'],
  },
  {
    name: '0004_watches.sql',
    core: true,
    tables: ['watches', 'watch_runs'],
    columns: ['usage_counters.via_watch'],
    indexes: ['idx_watches_user', 'idx_watches_due', 'idx_watches_baseline', 'idx_watch_runs_watch'],
  },
  { name: '0005_page_facts.sql', columns: ['captures.facts'] },
  {
    name: '0006_projects.sql',
    tables: [
      'projects',
      'project_captures',
      'project_watches',
      'capture_presets',
      'review_reports',
      'report_captures',
      'report_links',
      'report_comments',
    ],
    indexes: ['projects_owner'],
  },
  {
    name: '0007_collaboration.sql',
    tables: ['project_members', 'team_comments', 'project_digests', 'digest_deliveries'],
    indexes: ['members_user'],
  },
  { name: '0008_monitor_noise.sql', tables: ['watch_settings'] },
  { name: '0009_monitor_workflows.sql', tables: ['monitor_rules', 'alert_retries'], indexes: ['alert_retries_due'] },
  {
    name: '0010_mobile_push.sql',
    tables: ['push_devices', 'push_deliveries'],
    indexes: ['push_devices_user', 'push_deliveries_due'],
  },
  {
    name: '0011_apple_lite.sql',
    tables: ['apple_accounts', 'apple_subscriptions'],
    columns: ['users.free_quota', 'users.apple_expires_at'],
    indexes: ['apple_subscriptions_due'],
  },
  { name: '0012_watch_runs_user_index.sql', optional: true, indexes: ['idx_watch_runs_user'] },
  {
    name: '0013_capture_jobs.sql',
    optional: true,
    tables: ['capture_batches', 'capture_jobs'],
    indexes: [
      'idx_capture_batches_user',
      'idx_capture_batches_completed',
      'idx_capture_jobs_status',
      'idx_capture_jobs_user',
      'idx_capture_jobs_batch',
    ],
  },
  { name: '0014_pinned_baseline.sql', optional: true, columns: ['watches.baseline_pinned_at'] },
  {
    name: '0015_report_signoff_branding.sql',
    optional: true,
    tables: ['report_signoffs', 'project_branding'],
    indexes: ['report_signoffs_report'],
  },
];

/** The tables `/api/health` has always required. */
export const CORE_TABLES = MIGRATIONS.filter((entry) => entry.core).flatMap((entry) => entry.tables ?? []);

/**
 * The file to paste into the D1 console for a migration. 0001 has no upgrade
 * file: a database without it is empty, and apply-manually.sql is for that.
 */
export function upgradeFileFor(name: string): string {
  const number = name.slice(0, 4);
  return number === '0001' ? 'db/apply-manually.sql' : `db/${number}-upgrade.sql`;
}

export type MigrationStatus =
  | { name: string; applied: true }
  | { name: string; applied: false; optional: boolean; missing: string[]; upgrade: string };

/** Checks every migration's tables, columns and indexes in one query. */
export async function migrationStatus(db: D1Database): Promise<MigrationStatus[]> {
  const columnTables = [...new Set(MIGRATIONS.flatMap((entry) => entry.columns ?? []).map((c) => c.split('.')[0]!))];
  const sql = [
    `SELECT type AS kind, name FROM sqlite_master WHERE type IN ('table', 'index')`,
    ...columnTables.map(() => `SELECT 'column' AS kind, ? || '.' || name AS name FROM pragma_table_info(?)`),
  ].join(' UNION ALL ');

  const { results } = await db
    .prepare(sql)
    .bind(...columnTables.flatMap((table) => [table, table]))
    .all<{ kind: string; name: string }>();
  const present = new Set((results ?? []).map((row) => `${row.kind}:${row.name}`));

  return MIGRATIONS.map((entry) => {
    const missing = [
      ...(entry.tables ?? []).filter((table) => !present.has(`table:${table}`)),
      ...(entry.columns ?? []).filter((column) => !present.has(`column:${column}`)),
      ...(entry.indexes ?? []).filter((index) => !present.has(`index:${index}`)),
    ];
    return missing.length
      ? { name: entry.name, applied: false, optional: Boolean(entry.optional), missing, upgrade: upgradeFileFor(entry.name) }
      : { name: entry.name, applied: true };
  });
}
