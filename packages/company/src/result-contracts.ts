import {z} from 'zod';
import {dataResultContract} from '../../contracts/src/result-contract.js';
import {sourceReceiptSchema,codeFragmentSchema} from './contracts.js';
import {hash} from '../../storage/src/crypto.js';
const fragment=codeFragmentSchema.refine(v=>v.contentHash===hash(v.snippet),'CONTENT_HASH_MISMATCH'),common={source:sourceReceiptSchema,queryId:z.uuid(),untrustedContent:z.literal(true)};
export const companySearchResultContract=dataResultContract(z.object({...common,matches:z.array(fragment).max(20),totalCount:z.number().int().nonnegative().max(1000000000)}).strict().refine(v=>v.totalCount>=v.matches.length&&v.matches.every(f=>f.repo===v.source.repo&&f.commit===v.source.commit),'SOURCE_OR_COVERAGE_MISMATCH'));
export const companyReadResultContract=dataResultContract(z.object({...common,fragment,totalLines:z.number().int().positive().max(1000000)}).strict().refine(v=>v.fragment.repo===v.source.repo&&v.fragment.commit===v.source.commit&&v.totalLines>=v.fragment.endLine,'SOURCE_OR_RANGE_MISMATCH'));
