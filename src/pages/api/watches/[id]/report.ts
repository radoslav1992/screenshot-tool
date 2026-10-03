import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { HttpError,assertSameOrigin,readBody,json,badRequest } from '../../../../lib/http';
import { toHttpError } from '../../../../lib/errors';
import { assertVerified } from '../../../../lib/verification';
import { ownProject,projectAction,requireProjects } from '../../../../lib/projects';
import { getWatch } from '../../../../lib/watches';
import { checkRateLimit } from '../../../../lib/rate-limit';
import { decodeRunChanges } from '../../../../lib/monitor-health';
export const POST: APIRoute = async ({locals,request,params})=>{
 try {
 const user=locals.user;if(!user)throw new HttpError(401,'unauthorized','Sign in first.');
 assertSameOrigin(request);await assertVerified(user);await requireProjects();
 if(!(await checkRateLimit(`monitor-report:${user.id}`,30,3600)).ok)throw new HttpError(429,'rate_limited','Too many reports. Try later.');
 const watch=await getWatch(params.id || '');if(!watch||watch.user_id!==user.id)throw new HttpError(404,'not_found','Monitor not found.');
 const body=await readBody(request);const project=await ownProject(user.id,body.project_id || '');
 const selected=[...new Set((body.runs || '').split(',').filter(Boolean))];if(!selected.length||selected.length>2)throw badRequest('Select one or two comparisons.');
 const pairs: string[]=[];
 // The report draws each run's changed areas over its "after" image; the notes say how many.
 const areas: string[]=[];
 for(const [index,id] of selected.entries()){
 const run=await env.DB.prepare("SELECT baseline_capture_id,capture_id,detail FROM watch_runs WHERE id=? AND watch_id=? AND user_id=? AND status='done'").bind(id,watch.id,user.id).first<{baseline_capture_id:string;capture_id:string;detail:string|null}>();
 if(!run?.baseline_capture_id||!run.capture_id)throw badRequest('Comparison unavailable.');
 const regions=decodeRunChanges(run.detail).regions;if(regions.length){const line=`Changed areas: ${regions.length}, outlined on the after image.`;areas.push(selected.length>1?`Comparison ${index+1} · ${line}`:line);}
 for(const capture of [run.baseline_capture_id,run.capture_id]){
 const found=await env.DB.prepare("SELECT id FROM captures WHERE id=? AND user_id=? AND status='done' AND format IN ('png','jpg') AND mode!='series'").bind(capture,user.id).first();
 if(!found)throw badRequest('A screenshot has expired or cannot be included.');pairs.push(capture);
 }
 }
 await env.DB.batch(pairs.map(id=>env.DB.prepare('INSERT OR IGNORE INTO project_captures(project_id,capture_id) VALUES(?,?)').bind(project.id,id)));
 return json(await projectAction(user.id,{action:'report',project_id:project.id,title:body.title || 'Website change review',before:pairs[0],after:pairs[1],mobile_before:pairs[2] || '',mobile_after:pairs[3] || '',notes:[`Monitor: ${watch.label || watch.url}`,watch.url,...areas].join('\n')},new URL(request.url).origin));
 }catch(e){return toHttpError(e,'watch.report','Could not create report.').toResponse();}
};
