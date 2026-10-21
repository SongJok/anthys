import {hash} from '../../storage/src/crypto.js';
import {z} from 'zod';
import {dataResultContract} from '../../contracts/src/result-contract.js';
export const taskResultContract=dataResultContract(z.object({id:z.uuid(),goal:z.string(),status:z.enum(['OPEN','ACTIVE','PAUSED','COMPLETED','CANCELLED','EXPIRED'])}).strict().nullable());
export const taskBindingHash=hash(JSON.stringify({id:'tasks.get',version:'1.0.0',outputSchema:taskResultContract.outputSchema}));
