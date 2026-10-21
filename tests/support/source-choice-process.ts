import './isolation.js';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
const ctx=z.object({tenantId:z.uuid(),actorId:z.uuid()}).strict().parse(JSON.parse(process.argv[2]!)),replyId=z.uuid().parse(process.argv[3]),mode=z.enum(['claimed','rejected']).parse(process.argv[4]),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault);
const lease=await store.acquireSourceReply(ctx,replyId);if(!lease)throw Error('SOURCE_REPLY_CHILD_CLAIM_FAILED');
if(mode==='rejected')await db.scope(ctx,c=>c.query("UPDATE source_choice_replies SET state='REJECTED',rejection_code='SOURCE_OR_SCOPE_CHANGED' WHERE id=$1",[replyId]));
// Deliberately die before cleanup. This is a real separate process and durable
// PostgreSQL lease, not a claim that an enterprise CHECK was sent.
process.stdout.write('SOURCE_REPLY_DURABLE_'+mode.toUpperCase()+'\n');setInterval(()=>{},1000);
