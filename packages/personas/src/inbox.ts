import {z} from 'zod';
import type pg from 'pg';
import type {DbContext} from '../../storage/src/database.js';
import {Vault,type Sealed} from '../../storage/src/crypto.js';
import {personaCommand} from './commands.js';
const message=z.object({chatbotCorpId:z.string(),senderCorpId:z.string(),robotCode:z.string(),senderStaffId:z.string(),senderId:z.string(),chatbotUserId:z.string(),conversationId:z.string().min(1).max(512),conversationType:z.enum(['1','2']),msgtype:z.literal('text'),text:z.object({content:z.string().max(10000)})});
export type PersonaBinding={corpId:string;robotCode:string};
export async function verifiedPersonaInbox(c:pg.PoolClient,ctx:DbContext,vault:Vault,eventId:string,binding:PersonaBinding,state:'RECEIVED'|'PROCESSED'='RECEIVED'){
 try{z.uuid().parse(eventId);const row=(await c.query("SELECT e.payload_cipher_ref,u.external_user_id,u.auth_epoch,t.corp_id FROM event_inbox e JOIN users u ON u.tenant_id=e.tenant_id AND u.id=e.owner_id JOIN tenants t ON t.tenant_id=e.tenant_id WHERE e.tenant_id=$1 AND e.owner_id=$2 AND e.id=$3 AND e.source='DINGTALK' AND e.state=$4 AND u.status='ACTIVE' AND t.status='ACTIVE'",[ctx.tenantId,ctx.actorId,eventId,state])).rows[0];if(!row)return null;const m=message.parse(JSON.parse(vault.open(JSON.parse(row.payload_cipher_ref as string) as Sealed,`${ctx.tenantId}:${ctx.actorId}:inbox:${eventId}`)));if(row.corp_id!==binding.corpId||m.chatbotCorpId!==binding.corpId||m.senderCorpId!==binding.corpId||m.robotCode!==binding.robotCode||m.senderStaffId!==row.external_user_id||m.senderId===m.chatbotUserId)return null;const command=personaCommand(m.text.content);return command?{message:m,command,authEpoch:Number(row.auth_epoch)}:null;}catch{return null;}
}
