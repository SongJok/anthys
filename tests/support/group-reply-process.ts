import './isolation.js';
import {z} from 'zod';
import {secret} from '../../packages/config/src/index.js';
import {Database} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {RuntimeStore} from '../../packages/runtime/src/store.js';
import {GroupAudience} from '../../packages/groups/src/audience.js';
import {DwsIdentities} from '../../packages/dws/src/identity.js';
import {DwsRunner} from '../../packages/dws/src/runner.js';
const ctx=z.object({tenantId:z.uuid(),actorId:z.uuid()}).strict().parse(JSON.parse(process.argv[2]!)),replyId=z.uuid().parse(process.argv[3]),mode=z.enum(['claimed','rejected']).parse(process.argv[4]),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1'),store=new RuntimeStore(db,vault),runner=new DwsRunner(JSON.parse(process.argv[5]!));
if(runner.config.mode!=='SYNTHETIC_TEST')throw Error('SYNTHETIC_CHILD_ONLY');
store.configureGroupAudience(new GroupAudience(db,vault,new DwsIdentities(db,vault,runner),'robot-1'));
const lease=await store.acquireGroupReply(ctx,replyId);if(!lease)throw Error('GROUP_REPLY_CHILD_CLAIM_FAILED');
if(mode==='rejected')await db.scope(ctx,c=>c.query("UPDATE group_clarification_messages SET state='REJECTED',rejection_code='GROUP_AUDIENCE_UNVERIFIED' WHERE id=$1",[replyId]));
// The parent kills this real process after the durable PostgreSQL boundary.
// No claim is made that a live enterprise membership read took place.
process.stdout.write('GROUP_REPLY_DURABLE_'+mode.toUpperCase()+'\n');setInterval(()=>{},1000);
