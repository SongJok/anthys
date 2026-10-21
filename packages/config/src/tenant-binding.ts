import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import type {Database} from '../../storage/src/database.js';
const bindings=z.array(z.object({tenantId:z.uuid(),corpId:z.string().min(1)}).strict());
export async function resolveTenantBinding(db:Database,corpId:string|undefined,path:string):Promise<{tenantId:string;corpId:string}|null>{
 if(!corpId)return null;
 let raw:string;try{raw=await readFile(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
 const entries=bindings.parse(JSON.parse(raw)),selected=entries.filter(e=>e.corpId===corpId);if(selected.length!==1)throw Error('TENANT_BINDING_AMBIGUOUS_OR_MISSING');
 const b=selected[0]!;return db.scope({tenantId:b.tenantId,actorId:'00000000-0000-4000-8000-000000000000'},async c=>{const q=await c.query("SELECT id FROM tenants WHERE tenant_id=$1 AND corp_id=$2 AND status='ACTIVE'",[b.tenantId,b.corpId]);if(!q.rowCount)throw Error('TENANT_BINDING_INVALID');return b;});
}
export function authorizationUrl(clientId:string,origin:string,state:string):string{
 const url=new URL('https://login.dingtalk.com/oauth2/auth');url.search=new URLSearchParams({client_id:clientId,redirect_uri:new URL('/auth/callback',origin).toString(),state,response_type:'code',prompt:'consent',scope:'openid corpid'}).toString();return url.toString();
}
