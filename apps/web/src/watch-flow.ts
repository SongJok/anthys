import {z} from 'zod';
const uuid=z.uuid(),instant=z.iso.datetime({offset:true}),count=z.number().int().nonnegative();
const lifecycle=z.enum(['ACTIVE','PAUSED','CANCELLED']);
const summarySchema=z.object({id:uuid,lifecycle,stopReason:z.string().nullable(),notificationState:z.enum(['IDLE','PENDING','UNKNOWN']),checksStarted:count,notificationsReserved:count,maxChecks:count,maxNotifications:count,nextCheckAt:instant.nullable(),expiresAt:instant,policyHash:z.string().regex(/^[a-f0-9]{64}$/),createdAt:instant}).strict();
export type WatchSummary=z.infer<typeof summarySchema>;
const checkSchema=z.object({id:uuid,fence:z.number().int().positive(),state:z.enum(['CHECKING','COMPLETED','SUPPRESSED','FAILED']),outcome:z.string().nullable(),observation:z.unknown().nullable(),created_at:z.union([instant,z.date()]),completed_at:z.union([instant,z.date()]).nullable()}).passthrough();
const notificationSchema=z.object({id:uuid,check_id:uuid,value_hash:z.string(),state:z.enum(['PENDING','CONFIRMED','APPLIED_UNVERIFIED','FAILED','UNKNOWN']),attempts:z.number().int().nonnegative(),created_at:z.union([instant,z.date()]),updated_at:z.union([instant,z.date()]),settled_at:z.union([instant,z.date()]).nullable()}).passthrough();
export const watchDetailSchema=summarySchema.extend({intervalSeconds:z.number().int().positive(),lastObservation:z.unknown().nullable(),lastValueHash:z.string().nullable(),lastCheckStartedAt:instant.nullable(),lastNotificationAt:instant.nullable(),lastNotificationValueHash:z.string().nullable(),checks:z.array(checkSchema),notifications:z.array(notificationSchema)}).strict();
export type WatchDetail=z.infer<typeof watchDetailSchema>;
const createdSchema=z.object({watchId:uuid,policyHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const transitionSchema=z.object({found:z.boolean(),changed:z.boolean(),lifecycle:lifecycle,stop_reason:z.string().nullable().optional(),stopReason:z.string().nullable().optional(),next_check_at:instant.nullable().optional(),nextCheckAt:instant.nullable().optional()}).passthrough();
export type WatchTransition=z.infer<typeof transitionSchema>;
export class WatchFailure extends Error{constructor(readonly status:number,readonly code:string){super(code);}}
export type WatchTransport=(path:string,method:'GET'|'POST',body?:unknown)=>Promise<unknown>;
export class WatchFlow{
 detail:WatchDetail|null=null;list:WatchSummary[]|null=null;busy=false;notice='';
 constructor(private readonly transport:WatchTransport){}
 clear(){this.detail=null;this.list=null;this.notice='';}
 async readList():Promise<void>{this.busy=true;try{this.list=z.array(summarySchema).parse(await this.transport('/watches','GET'));this.notice='已从服务端重新读取当前所有者可见的监控。';}finally{this.busy=false;}}
 async read(id:string):Promise<void>{this.busy=true;try{this.detail=watchDetailSchema.parse(await this.transport('/watches/'+encodeURIComponent(uuid.parse(id)),'GET'));this.notice='已读取当前监控状态；按钮操作会再次提交服务端校验。';}finally{this.busy=false;}}
 async create(policy:unknown):Promise<z.infer<typeof createdSchema>>{this.busy=true;try{const result=createdSchema.parse(await this.transport('/watches','POST',policy));await this.readList();await this.read(result.watchId);this.notice='条件监控已登记。须绑定已认证数据来源后才会产生可通知的观测值。';return result;}finally{this.busy=false;}}
 async action(id:string,operation:'pause'|'resume'|'cancel'):Promise<WatchTransition>{this.busy=true;try{const result=transitionSchema.parse(await this.transport('/watches/'+encodeURIComponent(uuid.parse(id))+'/'+operation,'POST',{}));await this.read(id);this.notice=operation==='cancel'?'已登记停止后续检查；在途检查仍可能完成，但不会再预留新的通知。':operation==='pause'?'已暂停后续检查。':'已恢复后续检查；已耗尽预算或到期的监控不会因恢复而复活。';return result;}finally{this.busy=false;}}
 async bind(id:string,source:{scopeId:string;metric:'attempts'|'successes'|'successRate';windowSeconds:number}):Promise<void>{this.busy=true;try{await this.transport('/watches/'+encodeURIComponent(uuid.parse(id))+'/source','POST',source);await this.read(id);this.notice='数据来源绑定成功。绑定不可修改；作用域版本或授权变化会使其停止观测。';}finally{this.busy=false;}}
}
