import '../support/isolation.js';
import {randomUUID} from 'node:crypto';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {groupRuntimeFixture} from '../support/group-runtime.js';
import {groupInfoReply,groupMembersReply} from '../support/group-members.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';

it('T033: a complete roster adding an unbound external member after the first successful send check suppresses the prepared group reply',async()=>{
 const isolated=await groupReminderDatabase();await isolated.install();const {root,db}=isolated;
 const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
 let f:Awaited<ReturnType<typeof groupRuntimeFixture>>|undefined;
 try{
  f=await groupRuntimeFixture(root,db,vault);const fixture=f;
  await fixture.runtime.advance(fixture.ctx,fixture.runId);
  const state=await fixture.state();expect(state.status).toBe('WAITING_USER');
  expect(await fixture.gateway.finalResultAllowed(fixture.ctx,fixture.runId,state.result as string)).toBe(true);
  const delivery=(await db.scope(fixture.ctx,c=>c.query("SELECT id FROM deliveries WHERE source_run_id=$1 AND state='PENDING'",[fixture.runId]))).rows[0];
  const externalOpen='open-synthetic-external-'+randomUUID();
  expect((await root.query('SELECT id FROM users WHERE open_dingtalk_id=$1',[externalOpen])).rowCount).toBe(0);
  let checks=0,sends=0;
  const sender=new DeliveryGateway(db,vault,{
   sendReply:async()=>{sends++;return {state:'APPLIED_UNVERIFIED'};},
   sendProactive:async()=>{sends++;throw Error('T033_UNEXPECTED_PROACTIVE_SEND');}
  },fixture.binding,Date.now,async(...args)=>{
   const allowed=await fixture.gateway.finalSourcesAllowed(...args);checks++;
   if(checks===1){
    expect(allowed).toBe(true);
    // Both independently observed counts and the complete projected roster
    // include the new identity; no internal-directory authority is invented.
    await fixture.configure({reply:groupMembersReply(fixture.conversationId,[fixture.ownerOpen,fixture.otherOpen,externalOpen]),info:groupInfoReply(3,1,'external-member-joined')});
   }else expect(allowed).toBe(false);
   return allowed;
  });
  expect(await sender.process(fixture.ctx,delivery.id,new AbortController().signal)).toBe('SUPPRESSED');
  expect(checks).toBe(2);expect(sends).toBe(0);
  expect((await db.scope(fixture.ctx,c=>c.query('SELECT state,last_error FROM deliveries WHERE id=$1',[delivery.id]))).rows[0]).toMatchObject({state:'SUPPRESSED',last_error:'AUTHORIZATION_OR_SOURCE_UNVERIFIED'});
  expect(await fixture.gateway.finalResultAllowed(fixture.ctx,fixture.runId,state.result as string)).toBe(false);
  expect(fixture.requests).toHaveLength(2);
 }finally{await f?.close();await isolated.close();}
},60000);
