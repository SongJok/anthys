import {constants} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {isAbsolute,dirname} from 'node:path';
import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
import {groupConversationId} from '../../dws/src/group-contract.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true}).transform(v=>new Date(v).toISOString());
/** Operator execution pin, never an approval/grant installer. Each target still
 * requires an existing reviewed authorization and separately signed runner policy. */
export const groupReminderRuntimeProfile=z.object({schemaVersion:z.literal(1),approved:z.literal(true),purpose:z.literal('GROUP_REMINDER_RUN_ONCE'),reviewReference:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,511}$/),sourceReviewHash:sha,validFrom:instant,expiresAt:instant,maxNotifications:z.number().int().min(1).max(6),targets:z.array(z.object({tenantId:uuid,actorId:uuid,groupId:groupConversationId,scheduleId:uuid,authorizationId:uuid,authorizationHash:sha}).strict()).min(1).max(6),modelCalls:z.literal(0),allowMentionAll:z.literal(false),allowDirectMessages:z.literal(false),allowEscalation:z.literal(false)}).strict().superRefine((p,c)=>{if(Date.parse(p.expiresAt)<=Date.parse(p.validFrom)||Date.parse(p.expiresAt)-Date.parse(p.validFrom)>3600000)c.addIssue({code:'custom',message:'GROUP_REMINDER_RUNTIME_WINDOW'});if(new Set(p.targets.map(t=>t.tenantId+':'+t.actorId+':'+t.groupId)).size!==1)c.addIssue({code:'custom',message:'GROUP_REMINDER_RUNTIME_SINGLE_RECIPIENT_REQUIRED'});if(new Set(p.targets.map(t=>t.tenantId+':'+t.scheduleId)).size!==p.targets.length)c.addIssue({code:'custom',message:'GROUP_REMINDER_RUNTIME_DUPLICATE_TARGET'});});
export type GroupReminderRuntimeProfile=z.infer<typeof groupReminderRuntimeProfile>;
export type GroupReminderRuntimeTarget=GroupReminderRuntimeProfile['targets'][number];
export function groupReminderRuntimeFingerprint(raw:unknown){const document=groupReminderRuntimeProfile.parse(raw),serialized=JSON.stringify(document);return {document,serialized,hash:hash(serialized)};}
export async function readGroupReminderRuntimeProfile(path:string){
 if(!isAbsolute(path)||await realpath(path)!==path)throw Error('GROUP_REMINDER_RUNTIME_PRIVATE_PROFILE_REQUIRED');
 const parent=await lstat(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)throw Error('GROUP_REMINDER_RUNTIME_PRIVATE_PROFILE_REQUIRED');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o600||stat.size<2||stat.size>32768)throw Error('GROUP_REMINDER_RUNTIME_PRIVATE_PROFILE_REQUIRED');
  const bytes=Buffer.alloc(32769),read=await file.read(bytes,0,bytes.length,0),after=await file.stat();if(read.bytesRead!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||await realpath(path)!==path)throw Error('GROUP_REMINDER_RUNTIME_PROFILE_CHANGED');return groupReminderRuntimeFingerprint(JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8')));
 }finally{await file.close();}
}
