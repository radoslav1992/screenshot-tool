import { env } from 'cloudflare:workers';
import { defaultRule, type MonitorRule } from './monitor-rules';
/** Cached per isolate like watchSettingsReady: a yes for good, a no for a minute. */
let rulesTable: { ready: boolean; at: number } | undefined;
export async function workflowsReady() {
 if (rulesTable && (rulesTable.ready || Date.now() - rulesTable.at < 60_000)) return rulesTable.ready;
 const ready = !!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor_rules'").first();
 rulesTable = { ready, at: Date.now() };
 return ready;
}
export async function getMonitorRule(id: string): Promise<MonitorRule> {
 if (!await workflowsReady()) return { ...defaultRule };
 return await env.DB.prepare('SELECT kind,phrase,selector,region FROM monitor_rules WHERE watch_id=?').bind(id).first<MonitorRule>() || { ...defaultRule };
}
/** Each monitor's rule kind; monitors without a rule are visual. D1 binds at most 100 values a statement, so ids go 90 at a time. */
export async function ruleKinds(ids: string[]): Promise<Map<string, string>> {
 const kinds = new Map(ids.map(id => [id, defaultRule.kind]));
 if (!ids.length || !await workflowsReady()) return kinds;
 for (let at = 0; at < ids.length; at += 90) {
  const chunk = ids.slice(at, at + 90);
  const { results } = await env.DB.prepare(`SELECT watch_id,kind FROM monitor_rules WHERE watch_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ watch_id: string; kind: string }>();
  for (const row of results ?? []) kinds.set(row.watch_id, row.kind);
 }
 return kinds;
}
export async function saveMonitorRule(id: string, rule: MonitorRule) {
 await env.DB.prepare('INSERT INTO monitor_rules(watch_id,kind,phrase,selector,region) VALUES(?,?,?,?,?) ON CONFLICT(watch_id) DO UPDATE SET kind=excluded.kind,phrase=excluded.phrase,selector=excluded.selector,region=excluded.region').bind(id,rule.kind,rule.phrase,rule.selector,rule.region).run();
}
