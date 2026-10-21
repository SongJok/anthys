import {nativeArtifactDraftNotice} from './native-contracts.js';
import {z} from 'zod';
const uuid=z.uuid().transform(v=>v.toLowerCase()),sha=z.string().regex(/^[a-f0-9]{64}$/),instant=z.iso.datetime({offset:true});
export const artifactFormat=z.enum(['md','txt','csv','json','html','xlsx','docx','pdf']);
export const artifactCreateInput=z.object({runId:uuid,format:artifactFormat}).strict();
export const artifactMetadata=z.object({id:uuid,taskId:uuid,runId:uuid,format:artifactFormat,mime:z.string().min(1).max(256),fileName:z.string().min(1).max(160),byteSize:z.number().int().positive().max(8388608),sha256:sha,createdAt:instant,source:z.discriminatedUnion('mode',[z.object({mode:z.literal('VERIFIED_TASK_RESULT'),classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']),verification:z.enum(['VERIFIED','PARTIAL','UNVERIFIED']),asOf:instant,notice:z.string().min(1).max(2048)}).strict(),z.object({mode:z.literal('TOOL_DRAFT'),classification:z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']),verification:z.literal('UNVERIFIED'),asOf:instant,notice:z.literal(nativeArtifactDraftNotice)}).strict()])}).strict();
export type ArtifactMetadata=z.infer<typeof artifactMetadata>;
export type ArtifactCreateInput=z.infer<typeof artifactCreateInput>;
export class ArtifactAccessError extends Error{constructor(readonly code:string,readonly status:401|403|404|409|413|422|429|503){super(code);this.name='ArtifactAccessError';}}
export const artifactSourceNotice='导出保留原任务的来源范围、覆盖缺口和核验状态；文件格式检查不证明企业事实、根因或外部动作已完成。';
