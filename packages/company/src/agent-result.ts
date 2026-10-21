import {z} from 'zod';
import {dataResultContract} from '../../contracts/src/result-contract.js';
import type {ToolResult} from '../../contracts/src/index.js';
import {hash} from '../../storage/src/crypto.js';
import type {AgentChatResult} from './agent-chat.js';
import type {AgentRequestRow} from './agent-requests.js';
export const agentTextDataSchema=z.object({
 requestId:z.uuid(),text:z.string().min(1).max(262144),textHash:z.string().regex(/^[a-f0-9]{64}$/),
 source:z.object({kind:z.literal('ENTERPRISE_AGENT_MCP'),connectorId:z.string().max(128),toolName:z.string().max(128),inputSchemaHash:z.string().regex(/^[a-f0-9]{64}$/),scopeHash:z.string().regex(/^[a-f0-9]{64}$/),receiptHash:z.string().regex(/^[a-f0-9]{64}$/),receivedAt:z.iso.datetime(),verification:z.literal('UNVERIFIED'),notice:z.string().max(1024)}).strict()
}).strict().refine(value=>hash(value.text)===value.textHash,'AGENT_TEXT_HASH_MISMATCH');
const baseResult=dataResultContract(agentTextDataSchema);
const resultSchema=baseResult.resultSchema.superRefine((r,c)=>{if(r.data!==undefined&&(r.status!=='OK'||r.completeness!=='UNKNOWN'||r.verification?.state!=='UNVERIFIED'||r.verification.method!=='MCP_TEXT_RECEIPT_ONLY'))c.addIssue({code:'custom',message:'AGENT_RECEIPT_CANNOT_CERTIFY_FACTS'});});
export const agentTextResultContract={resultSchema,outputSchema:z.toJSONSchema(resultSchema)};
/** A transport receipt is not an independently checked enterprise fact. */
export function agentTextResult(row:AgentRequestRow,reply:Extract<AgentChatResult,{status:'RESPONSE_RECEIVED'}>):ToolResult{
 const data=agentTextDataSchema.parse({requestId:row.id,text:reply.text,textHash:hash(reply.text),source:{kind:'ENTERPRISE_AGENT_MCP',connectorId:row.connector_id,toolName:row.tool_name,inputSchemaHash:row.input_schema_hash,scopeHash:row.scope_hash,receiptHash:row['response_hash'],receivedAt:reply.source.receivedAt,verification:'UNVERIFIED',notice:reply.source.notice}});
 return {status:'OK',data,evidenceIds:[`enterprise-agent:${row.id}`],completeness:'UNKNOWN',verification:{state:'UNVERIFIED',method:'MCP_TEXT_RECEIPT_ONLY'}};
}
