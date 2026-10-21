import '../support/isolation.js';
import {randomBytes} from 'node:crypto';
import {vi} from 'vitest';
import {Vault} from '../../packages/storage/src/crypto.js';
import {groupReminderDatabase} from '../support/group-reminder-database.js';
import {reminderExecution} from '../support/group-reminder-execution.js';
it('synthetic queue waits for the actual PostgreSQL due instant even if the local wall clock leads by 250ms',async()=>{
 const d=await groupReminderDatabase();let s:Awaited<ReturnType<typeof reminderExecution>>|undefined;try{
  await d.install();s=await reminderExecution(d,new Vault(new Map([['1',randomBytes(32)]]),'1'),1);const now=Date.now,clock=vi.spyOn(Date,'now').mockImplementation(()=>now()+250);
  try{const q=await s.queue();const row=(await d.root.query('SELECT state,scheduled_at,clock_timestamp() observed_at FROM group_reminder_occurrences WHERE id=$1',[q.occurrenceId])).rows[0];expect(row.state).toBe('QUEUED');expect(new Date(row.observed_at).getTime()).toBeGreaterThanOrEqual(new Date(row.scheduled_at).getTime());}finally{clock.mockRestore();}
 }finally{await s?.close();await d.close();}
},30000);
