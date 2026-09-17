import { env } from 'cloudflare:workers';
import { defaultRule, type MonitorRule } from './monitor-rules';
export async function workflowsReady() {
 return !!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='monitor_rules'").first();
}
export async function getMonitorRule(id: string): Promise<MonitorRule> {
 if (!await workflowsReady()) return { ...defaultRule };
 return await env.DB.prepare('SELECT kind,phrase,selector,region FROM monitor_rules WHERE watch_id=?').bind(id).first<MonitorRule>() || { ...defaultRule };
}
export async function saveMonitorRule(id: string, rule: MonitorRule) {
 await env.DB.prepare('INSERT INTO monitor_rules(watch_id,kind,phrase,selector,region) VALUES(?,?,?,?,?) ON CONFLICT(watch_id) DO UPDATE SET kind=excluded.kind,phrase=excluded.phrase,selector=excluded.selector,region=excluded.region').bind(id,rule.kind,rule.phrase,rule.selector,rule.region).run();
}
