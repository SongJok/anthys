import './isolation.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {CardCoordinator} from '../../packages/gateway/src/cards.js';
const mode=process.argv[2]!,ctx=z.object({tenantId:z.uuid(),actorId:z.uuid()}).parse(JSON.parse(process.argv[3]!)),id=z.uuid().parse(process.argv[4]),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
const count=async(kind:string)=>db.scope(ctx,c=>c.query("INSERT INTO outbox(tenant_id,id,owner_id,kind,aggregate_id,payload_ref,dedup_key,published_at) VALUES($1,$2,$3,$4,$5,'{}',$6,now())",[ctx.tenantId,randomUUID(),ctx.actorId,kind,id,randomUUID()]));
try{const row=(await db.scope(ctx,c=>c.query('SELECT next_at FROM card_instances WHERE id=$1',[id]))).rows[0];const now=Math.max(Date.now(),new Date(row.next_at as string).getTime())+1000;const coordinator=new CardCoordinator(db,vault,{create:async()=>{await count('SYNTHETIC_CARD_CREATE');if(mode==='hold'){console.log('CARD_NETWORK_IN_FLIGHT');await new Promise(()=>{});}return {state:'APPLIED_UNVERIFIED'};},update:async input=>{await count(input.finalize?'SYNTHETIC_CARD_FINALIZE':'SYNTHETIC_CARD_UPDATE');return {state:'APPLIED_UNVERIFIED'};}},{corpId:'TENANT_A',appOrigin:'http://localhost:52330',template:{templateId:'synthetic-template',statusKey:'status',taskUrlKey:'taskUrl',cancelTokenKey:'cancelToken'}},()=>now);if(mode==='recover')await coordinator.due(ctx);console.log(JSON.stringify({state:await coordinator.process(ctx,id,new AbortController().signal)}));}finally{await db.close();}
