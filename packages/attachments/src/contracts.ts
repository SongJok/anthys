import {attachmentTextResultContract} from './result-contracts.js';
import {z} from 'zod';
import {hash} from '../../storage/src/crypto.js';
export const attachmentInputSchema=z.object({attachmentId:z.uuid().transform(id=>id.toLowerCase())}).strict();
export const attachmentInputJsonSchema={type:'object',properties:{attachmentId:{type:'string',format:'uuid'}},required:['attachmentId'],additionalProperties:false};
export const attachmentReadSchema=attachmentInputSchema.extend({offset:z.number().int().min(0).max(8*1024*1024).default(0),limit:z.number().int().min(2).max(8192).default(8192)}).strict();
export const attachmentReadJsonSchema={...attachmentInputJsonSchema,properties:{...attachmentInputJsonSchema.properties,offset:{type:'integer',minimum:0,maximum:8*1024*1024,default:0},limit:{type:'integer',minimum:2,maximum:8192,default:8192}}};
export const attachmentReadBindingHash=hash(JSON.stringify({logicalId:'attachments.read_text',version:'1.0.0',inputSchema:attachmentReadJsonSchema,outputSchema:attachmentTextResultContract.outputSchema,risk:'READ',provider:'DINGTALK_API',policy:{canonicalIdentifier:'uuid-lowercase',encryptedResult:true,explicitModelEgressGrant:true,sourceRevalidation:true,offsetUnit:'UTF16_CODE_UNITS'}}));
