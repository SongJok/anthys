import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
import type {TrialProfile} from '../../config/src/one-shot-trial.js';
export const trialServiceSchema=z.enum(['ingress','worker','notifier']);
export type TrialService=z.infer<typeof trialServiceSchema>;
export const trialFixtureSchema=z.enum(['idle','busy','grandchild','native-worker']);
export type TrialFixture=z.infer<typeof trialFixtureSchema>;
export const trialOwnedMarker=Symbol.for('open_aider.ownedTrialService');
export const trialEnvironmentMarker=Symbol.for('open_aider.reviewedRuntimeEnvironment');
const markerSchema=z.object({profileHash:z.string().regex(/^[a-f0-9]{64}$/),deadlineAt:z.number().int().positive(),service:trialServiceSchema,guardianPid:z.number().int().positive(),pid:z.number().int().positive()}).strict();
export function assertOwnedTrialService(profile:TrialProfile,service:TrialService):void{
 const parsed=markerSchema.safeParse(Reflect.get(globalThis,trialOwnedMarker));
 if(!parsed.success||!process.connected||parsed.data.pid!==process.pid||parsed.data.guardianPid!==process.ppid||parsed.data.service!==service||parsed.data.profileHash!==hash(JSON.stringify(profile))||parsed.data.deadlineAt!==Date.parse(profile.deadline)||Date.now()>=parsed.data.deadlineAt)throw Error('TRIAL_SUPERVISION_REQUIRED');
}
export const supervisorInitSchema=z.object({kind:z.literal('INIT'),executionToken:z.string().regex(/^[a-f0-9]{32}$/),parentPid:z.number().int().positive(),profilePath:z.string().min(1),profileHash:z.string().regex(/^[a-f0-9]{64}$/),runtimeDirectory:z.string().min(1),services:z.array(z.object({service:trialServiceSchema,fixture:trialFixtureSchema.optional()}).strict()).min(1).max(3)}).strict().refine(v=>new Set(v.services.map(s=>s.service)).size===v.services.length);
export type SupervisorInit=z.infer<typeof supervisorInitSchema>;
export const trialStopReasonSchema=z.enum(['TRIAL_DEADLINE','TRIAL_OPERATOR_STOP','TRIAL_CLOSED','TRIAL_AUTHORITY_UNAVAILABLE','TRIAL_PARENT_LOST','TRIAL_PARENT_UNRESPONSIVE','TRIAL_GUARDIAN_LOST','TRIAL_SERVICE_LOST','TRIAL_PROTOCOL_INVALID','TRIAL_STARTUP_FAILED']);
export type TrialStopReason=z.infer<typeof trialStopReasonSchema>;
export const trialSupervisorReceiptSchema=z.object({reason:trialStopReasonSchema,profileHash:z.string().regex(/^[a-f0-9]{64}$/),deadlineAt:z.number().int().positive(),guardianPid:z.number().int().positive(),parentPid:z.number().int().positive(),databaseClosed:z.boolean(),groups:z.array(z.object({pid:z.number().int().positive(),service:trialServiceSchema,closed:z.boolean()}).strict()).max(3),ownedGroupsClosed:z.boolean(),startedAt:z.string(),endedAt:z.string()}).strict();
export type TrialSupervisorReceipt=z.infer<typeof trialSupervisorReceiptSchema>;
export const guardianEventSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('PONG'),executionToken:z.string()}).strict(),
 z.object({kind:z.literal('READY'),executionToken:z.string(),guardianPid:z.number().int().positive(),deadlineAt:z.number().int().positive(),monoDeadlineNs:z.string().regex(/^\d{1,30}$/)}).strict(),
 z.object({kind:z.literal('REGISTER'),executionToken:z.string(),pid:z.number().int().positive(),service:trialServiceSchema}).strict(),
 z.object({kind:z.literal('SERVICE_READY'),executionToken:z.string(),pid:z.number().int().positive(),service:trialServiceSchema}).strict(),
 z.object({kind:z.literal('STOPPED'),executionToken:z.string(),receipt:trialSupervisorReceiptSchema}).strict(),
 z.object({kind:z.literal('FAILED'),executionToken:z.string(),code:z.enum(['TRIAL_STARTUP_FAILED','TRIAL_CLAIM_CONSUMED']),stage:z.string().regex(/^[A-Z_]{1,64}$/).optional()}).strict()
]);
export const guardianControlSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('PING'),executionToken:z.string()}).strict(),
 z.object({kind:z.literal('START_SERVICES'),executionToken:z.string()}).strict(),
 z.object({kind:z.literal('REGISTER_ACK'),executionToken:z.string(),pid:z.number().int().positive()}).strict(),
 z.object({kind:z.literal('STOP'),executionToken:z.string(),reason:trialStopReasonSchema}).strict()
]);
export function trialGroupAlive(pid:number):boolean{try{process.kill(-pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}}
export function signalTrialGroup(pid:number,signal:NodeJS.Signals):void{if(!Number.isSafeInteger(pid)||pid<=1||pid===process.pid)throw Error('TRIAL_GROUP_OWNERSHIP_INVALID');try{process.kill(-pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
export type TrialDeadline={deadlineAt:number;monoDeadlineNs:bigint};
// hrtime uses the local kernel's monotonic clock. Both owned control processes
// validate the same absolute ns boundary; they never create a new duration.
export function trialWallNow(){const shift=isolatedTrialFixtureAllowed()?Number(process.env['OA_TRIAL_TEST_WALL_SHIFT_MS']??0):0;return Date.now()+(Number.isFinite(shift)&&Math.abs(shift)<=3600000?shift:0);}
export function trialRemainingMs(bound:TrialDeadline,wall=trialWallNow(),mono=process.hrtime.bigint()):number{
 return Math.max(0,Math.min(bound.deadlineAt-wall,Number((bound.monoDeadlineNs-mono)/1000000n)));
}
export function isolatedTrialFixtureAllowed(){return process.env['OA_TEST_ISOLATED']==='true'&&process.env['APP_ENV']==='test'&&Reflect.get(globalThis,Symbol.for('open_aider.testNetworkGuard'))===true;}
export function trialProcessEnvironment(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv{
 const names=['PATH','HOME','TMPDIR','LANG','LC_ALL','APP_ENV','APP_ORIGIN','PORT','HOST','RELEASE_PROFILE','DATABASE_URL','RUNTIME_DATABASE_URL','QUEUE_DATABASE_URL','APP_MASTER_KEY','SESSION_SECRET','GLM_API_KEY','GLM_BASE_URL','GLM_MODEL','DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_APP_KEY','DINGTALK_APP_SECRET','DINGTALK_CORP_ID','DINGTALK_ROBOT_CODE','AIDER_AI_DEFAULT_API_KEY','AIDER_AI_DEFAULT_BASE_URL','AIDER_AI_DEFAULT_MODEL','BUDGET_POLICY_FILE','WORKER_SCOPE_FILE','TENANT_BINDINGS_FILE'];
 const selected:NodeJS.ProcessEnv={};for(const name of names)for(const key of [name,name+'_FILE'])if(env[key]!==undefined)selected[key]=env[key];
 if(isolatedTrialFixtureAllowed()){selected['APP_ENV']='test';selected['OA_TEST_ISOLATED']='true';if(env['NODE_OPTIONS'])selected['NODE_OPTIONS']=env['NODE_OPTIONS'];if(env['OA_TRIAL_TEST_WALL_SHIFT_MS'])selected['OA_TRIAL_TEST_WALL_SHIFT_MS']=env['OA_TRIAL_TEST_WALL_SHIFT_MS'];}
 selected['DINGTALK_REPLY_ONLY']='true';selected['DWS_ENABLED']='false';selected['MOCK_PROVIDERS']='false';return selected;
}
