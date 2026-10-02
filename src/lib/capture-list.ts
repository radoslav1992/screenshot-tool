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
}
export function captureListQuery(userId: string, options: CaptureListOptions = {}) {
  const limit = Number.isFinite(options.limit) ? Math.min(Math.max(Math.trunc(options.limit!), 1), 100) : 30;
  const offset = Number.isFinite(options.offset) ? Math.min(Math.max(Math.trunc(options.offset!), 0), 10000) : 0;
  const clauses = ['captures.user_id = ?'];
  const binds: Array<string | number> = [userId];
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
    clauses.push('created_at < ?');
    binds.push(options.cursor);
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
