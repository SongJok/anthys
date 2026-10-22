import {z} from 'zod';
import {dataResultContract} from '../../contracts/src/result-contract.js';
import {canonical} from '../../gateway/src/index.js';
import {dataAggregateResultSchema,dataCanonicalQuerySchema,canonicalInstantSchema,dataCompletenessSchema,dataRowScopeSchema,dataSourceReceiptSchema,dataTemplateRefSchema,dataWindowSchema} from './data-contracts.js';
export const companyDataResultContract=dataResultContract(z.object({
 source:dataSourceReceiptSchema,query:dataCanonicalQuerySchema,template:dataTemplateRefSchema,queryId:z.uuid(),
 watermark:canonicalInstantSchema,observedAt:canonicalInstantSchema,completeness:dataCompletenessSchema,window:dataWindowSchema,rowScope:dataRowScopeSchema,
 metrics:dataAggregateResultSchema.shape.metrics,untrustedContent:z.literal(true),upstreamCertification:z.literal('UNVERIFIED')
}).strict().superRefine((value,ctx)=>{
 if(value.queryId!==value.source.queryId)ctx.addIssue({code:'custom',path:['queryId'],message:'QUERY_ID_MISMATCH'});
 if(value.template.key!==value.query.templateKey||value.template.version!==value.query.templateVersion||value.template.key!==value.source.templateKey||value.template.version!==value.source.templateVersion||value.template.hash!==value.source.templateHash)ctx.addIssue({code:'custom',path:['template'],message:'TEMPLATE_MISMATCH'});
 if(value.watermark!==value.source.watermark||value.observedAt!==value.source.observedAt||value.completeness!==value.source.completeness)ctx.addIssue({code:'custom',path:['source'],message:'SOURCE_RECEIPT_MISMATCH'});
 if(canonical(value.window)!==canonical({start:value.query.start,end:value.query.end,interval:'[start,end)'}))ctx.addIssue({code:'custom',path:['window'],message:'WINDOW_MISMATCH'});
}));
