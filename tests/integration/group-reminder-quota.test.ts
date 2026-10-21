import '../support/isolation.js';
import {secret} from '../../packages/config/src/index.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DeliveryGateway} from '../../packages/gateway/src/delivery.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {reminderExecution} from '../support/group-reminder-execution.js';
const vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
let d:Awaited<ReturnType<typeof groupReminderDatabase>>,s:Awaited<ReturnType<typeof reminderExecution>>,unknownDelivery:string,sends=0;
beforeAll(async()=>{d=await groupReminderDatabase();await d.install();s=await reminderExecution(d,vault,1);});afterAll(async()=>{await s?.close();await d?.close();});
const signal=()=>new AbortController().signal;
const count=async()=>Number((await d.root.query('SELECT count(*) n FROM group_reminder_notifications WHERE tenant_id=$1',[s.w.principal.tenantId])).rows[0].n);
const deliveryId=async(id:string)=>(await d.root.query('SELECT delivery_id FROM group_reminder_occurrences WHERE id=$1',[id])).rows[0].delivery_id as string;
async function deliver(id:string,state:'UNKNOWN'|'APPLIED_UNVERIFIED'){
 const gateway=new DeliveryGateway(d.db,vault,{sendReply:async()=>{throw Error('UNEXPECTED');},sendProactive:async()=>{sends++;return {state};}},s.w.f.binding,Date.now,undefined,s.verifier);
 expect(await gateway.process(s.w.f.ctx,id,signal())).toBe(state);const before=sends;expect(await gateway.process(s.w.f.ctx,id,signal())).toBe('NOT_CLAIMED');expect(sends).toBe(before);
}
// One real ledger survives every bounded serial phase. All grants, roster,
// reservations, limits and gateway checks are production implementations.
describe('group-wide unresolved reminder reservations',{concurrent:false},()=>{
 it('preserves a real UNKNOWN physical outcome and refuses to resend it',async()=>{
  const q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,signal())).toBe('STAGED');unknownDelivery=await deliveryId(q.occurrenceId);await deliver(unknownDelivery,'UNKNOWN');expect(sends).toBe(1);expect(await count()).toBe(1);
 });
 it('blocks the same unresolved case even in a new plan without consuming another reservation',async()=>{const q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,signal())).toBe('SKIPPED');expect(await count()).toBe(1);expect((await d.root.query('SELECT state FROM deliveries WHERE id=$1',[unknownDelivery])).rows[0].state).toBe('UNKNOWN');});
 it('can remind a different resource once without refunding the unknown reservation',async()=>{await s.addCase();const q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,signal())).toBe('STAGED');await deliver(await deliveryId(q.occurrenceId),'APPLIED_UNVERIFIED');expect(await count()).toBe(2);});
 it('can remind that resolved-delivery resource a second time in its local day',async()=>{const q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,signal())).toBe('STAGED');await deliver(await deliveryId(q.occurrenceId),'APPLIED_UNVERIFIED');expect(await count()).toBe(3);});
 it('refuses its third daily reminder with no task or extra reservation',async()=>{const q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,signal())).toBe('SKIPPED');expect(await count()).toBe(3);expect((await d.root.query('SELECT task_id,delivery_id FROM group_reminder_occurrences WHERE id=$1',[q.occurrenceId])).rows[0]).toEqual({task_id:null,delivery_id:null});});
 for(const expected of [4,5,6])it(`counts pending and UNKNOWN group-wide reservations up to ${expected}`,async()=>{await s.addCase();const q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,signal())).toBe('STAGED');expect(await count()).toBe(expected);expect(sends).toBe(3);});
 it('blocks the seventh group summary even when a new different resource is overdue',async()=>{await s.addCase();const q=await s.queue();expect(await s.scheduler.stage(s.w.f.ctx,q.occurrenceId,signal())).toBe('SKIPPED');expect(await count()).toBe(6);expect(sends).toBe(3);expect(s.w.f.requests).toEqual([]);});
});
