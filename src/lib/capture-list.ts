/** Bound parameters keep search text literal and every page scoped to its owner. */
export interface CaptureListOptions {
  mode?: string;
  limit?: number;
  cursor?: string;
  search?: string;
  offset?: number;
}
export function captureListQuery(userId: string, options: CaptureListOptions = {}) {
  const limit = Number.isFinite(options.limit) ? Math.min(Math.max(Math.trunc(options.limit!), 1), 100) : 30;
  const offset = Number.isFinite(options.offset) ? Math.min(Math.max(Math.trunc(options.offset!), 0), 10000) : 0;
  const clauses = ['user_id = ?'];
  const binds: Array<string | number> = [userId];
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
