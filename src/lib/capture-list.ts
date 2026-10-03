/** Bound parameters keep search text literal and every page scoped to its owner. */
export interface CaptureListOptions {
  mode?: string;
  collection?: 'regular' | 'monitors';
  watchId?: string;
  unassigned?: boolean;
  changedOnly?: boolean;
  limit?: number;
  cursor?: string;
  search?: string;
  offset?: number;
  /** Fetch one row past the page, to learn whether another page follows. */
  lookahead?: boolean;
  /** Include background captures that are still queued or running. */
  includePending?: boolean;
}

/**
 * Statuses a capture has only while its background job waits or runs. Lists
 * leave them out unless asked: the iOS app shows any capture that is not done
 * as a failure, and a batch of hundreds queued would fill its library with
 * warnings. A synchronous render's `pending` is not one of them — it lasts
 * only as long as the request that is waiting for it.
 */
export const BACKGROUND_STATUSES = ['queued', 'running'] as const;
/** The page size a list request gets: 1–100, 30 when unsaid. */
export function listLimit(limit: number | undefined): number {
  return Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit!), 1), 100) : 30;
}

/**
 * Where the next page starts: the last row's timestamp and id. The id is what
 * keeps rows created in the same millisecond from falling between two pages.
 */
export function captureCursor(row: { created_at: string; id: string }): string {
  return `${row.created_at}~${row.id}`;
}

export function captureListQuery(userId: string, options: CaptureListOptions = {}) {
  // `lookahead` asks for one row more than the page, so the caller can tell
  // whether there is a next page without fetching it.
  const limit = listLimit(options.limit) + (options.lookahead ? 1 : 0);
  const offset = Number.isFinite(options.offset) ? Math.min(Math.max(Math.trunc(options.offset!), 0), 10000) : 0;
  const clauses = ['captures.user_id = ?'];
  const binds: Array<string | number> = [userId];
  if (!options.includePending) {
    clauses.push(`captures.status NOT IN (${BACKGROUND_STATUSES.map((status) => `'${status}'`).join(', ')})`);
  }
  if (options.collection === 'regular') {
    clauses.push("captures.source <> 'watch'", `NOT (${monitorMembership})`);
  } else if (options.collection === 'monitors') {
    if (options.watchId) {
      clauses.push(`EXISTS (SELECT 1 FROM watches w WHERE w.id = ? AND ${monitorMatch})`);
      binds.push(options.watchId);
      if (options.changedOnly) { clauses.push('EXISTS (SELECT 1 FROM watch_runs r WHERE r.watch_id=? AND r.user_id=captures.user_id AND r.capture_id=captures.id AND r.changed=1)'); binds.push(options.watchId); }
    } else if (options.unassigned) {
      clauses.push("captures.source = 'watch'", `NOT (${monitorMembership})`);
    } else {
      clauses.push(`(captures.source = 'watch' OR ${monitorMembership})`);
    }
  }
  if (options.mode && options.mode !== 'all') {
    clauses.push('mode = ?');
    binds.push(options.mode);
  }
  if (options.cursor) {
    // A bare timestamp is the cursor format before ids were added; it still
    // works, it just cannot split rows that share a timestamp.
    const at = options.cursor.lastIndexOf('~');
    if (at > 0) {
      clauses.push('(captures.created_at < ? OR (captures.created_at = ? AND captures.id < ?))');
      binds.push(options.cursor.slice(0, at), options.cursor.slice(0, at), options.cursor.slice(at + 1));
    } else {
      clauses.push('created_at < ?');
      binds.push(options.cursor);
    }
  }
  const search = options.search?.trim().slice(0, 200);
  if (search) {
    clauses.push('instr(lower(url), lower(?)) > 0');
    binds.push(search);
  }
  binds.push(limit, offset);
  return {
    sql: `SELECT * FROM captures WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    binds,
  };
}

/** Explicit job relationships; never group by URL, which multiple jobs can share. */
export const monitorMatch = `w.user_id = captures.user_id AND (
  w.baseline_capture_id = captures.id OR EXISTS (
    SELECT 1 FROM watch_runs r WHERE r.watch_id = w.id AND r.user_id = captures.user_id
    AND (r.capture_id = captures.id OR r.baseline_capture_id = captures.id)
  )
)`;
const monitorMembership = `EXISTS (SELECT 1 FROM watches w WHERE ${monitorMatch})`;

export function monitorFoldersQuery(userId: string, search = '') {
  return {
    sql: `SELECT w.id, w.label, w.url, w.status,
      (SELECT captures.id FROM captures WHERE ${monitorMatch} AND captures.status='done' ORDER BY captures.created_at DESC,captures.id DESC LIMIT 1) AS cover_id,
      (SELECT COUNT(*) FROM captures WHERE ${monitorMatch}) AS capture_count
      FROM watches w WHERE w.user_id = ?
      AND (instr(lower(w.label), lower(?)) > 0 OR instr(lower(w.url), lower(?)) > 0)
      ORDER BY w.created_at DESC, w.id DESC`,
    binds: [userId, search.trim().slice(0, 200), search.trim().slice(0, 200)],
  };
}
