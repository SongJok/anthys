import {z} from 'zod';
import {scheduleRuleSchema} from '../../schedules/src/rules.js';

const uuid=z.uuid(),positive=z.number().int().positive().safe(),instant=z.iso.datetime({offset:true});
export const groupReminderLimits=z.object({remindersPerCasePerDay:z.number().int().min(0).max(2),summariesPerGroupPerHour:z.number().int().min(0).max(6)}).strict();
export const groupReminderWorkHours=z.object({timezone:z.string().min(1).max(128),windows:z.array(z.object({daysOfWeek:z.array(z.number().int().min(1).max(7)).min(1).max(7),start:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),end:z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/)}).strict()).min(1).max(100)}).strict();
/** A rule is not a group authorization. Every operation must resolve current persisted authority. */
export const groupReminderRule=scheduleRuleSchema.refine(r=>r.misfire.kind==='REMINDER_LATEST'&&!r.businessCalendar,'GROUP_REMINDER_RULE_UNSUPPORTED');
export const groupReminderCreate=z.object({authorizationId:uuid,contractVersion:positive,rule:groupReminderRule,confirmGroupNotifications:z.literal(true)}).strict();
export const groupReminderEdit=z.object({expectedRevision:positive,rule:groupReminderRule}).strict();
export const groupReminderTransition=z.object({expectedRevision:positive}).strict();
export const groupReminderPreviewInput=z.object({rule:groupReminderRule}).strict();
export const groupReminderListInput=z.object({cursor:uuid.optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict();
export const groupReminderAuthorization=z.object({id:uuid,contractVersion:positive,expiresAt:instant,limits:groupReminderLimits,workHours:groupReminderWorkHours}).strict();
const occurrence=z.object({id:uuid,scheduledAt:instant,deliveryState:z.enum(['QUEUED','PENDING','SENDING','APPLIED_UNVERIFIED','UNKNOWN','FAILED','SUPPRESSED','MISSED','SKIPPED','REVOKED']),verification:z.literal('UNVERIFIED'),itemCount:z.number().int().min(0).max(20)}).strict();
export const groupReminderSchedule=z.object({id:uuid,groupId:z.string().min(1).max(512),contractId:uuid,contractVersion:positive,authorizationId:uuid,authorizationExpiresAt:instant,revision:positive,generation:positive,state:z.enum(['ACTIVE','PAUSED','CANCELLED','COMPLETED','BLOCKED']),rule:groupReminderRule,limits:groupReminderLimits,workHours:groupReminderWorkHours,nextDueAt:instant.nullable(),lastError:z.string().min(1).max(128).nullable(),createdAt:instant,updatedAt:instant,lastOccurrence:occurrence.nullable()}).strict();
export const groupReminderCoverage=z.object({mode:z.literal('MENTION_ONLY'),completeChat:z.literal(false),notice:z.string().min(1).max(2000)}).strict();
export const groupReminderPage=z.object({items:z.array(groupReminderSchedule).max(50),authorizations:z.array(groupReminderAuthorization).max(50),nextCursor:uuid.nullable(),asOf:instant,coverage:groupReminderCoverage}).strict();
export const groupReminderControl=z.object({id:uuid,groupId:z.string().min(1).max(512),authorizationId:uuid,revision:positive,generation:positive,state:groupReminderSchedule.shape.state,nextDueAt:instant.nullable()}).strict();
export const groupReminderReceipt=z.union([z.object({schedule:groupReminderSchedule,replayed:z.boolean()}).strict(),z.object({control:groupReminderControl,replayed:z.boolean()}).strict()]);
export type GroupReminderSchedule=z.infer<typeof groupReminderSchedule>;
export type GroupReminderPage=z.infer<typeof groupReminderPage>;
export type GroupReminderRule=z.infer<typeof groupReminderRule>;
export class GroupReminderError extends Error{constructor(readonly code:string,readonly status=403,options?:ErrorOptions){super(code,options);}}
export const groupReminderNotice='仅催办当前合同允许且已登记的 @／共享卡片事项，不覆盖全部群聊；每事项每天最多2次、每群工作时段每小时最多6条，可由管理员调低。未默认@全员、跨通道私信或升级；UNKNOWN保留额度且不自动重发。提供方接收不代表事务完成或外部结果已验证。';
