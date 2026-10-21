import {readFile} from 'node:fs/promises';
import {rpcHash} from './signed-protocol.js';
import {DwsError} from './contracts.js';
export type GroupBindingInput={binaryHash:string;schemaHash:string;groupMembersSchemaHash:string;groupInfoSchemaHash:string};
// Used by both production entrypoints. These are CLI metadata attestations only;
// independent user/corp/scope/directory checks remain mandatory at every read.
export async function assertReviewedGroupReadBinding(input:GroupBindingInput,platform:string){
 const lock=JSON.parse(await readFile('config/dws/lock.json','utf8')),contract=JSON.parse(await readFile('config/dws/group-members-contract.json','utf8'));
 if(contract.cliVersion!==lock.version||contract.sourceCommit!==lock.sourceCommit||input.binaryHash!==lock.platforms[platform]?.binarySha256||input.schemaHash!==lock.commands['contact.me']?.schemaHash)throw new DwsError('DWS_GROUP_BINDING_UNCERTIFIED');
 for(const [key,path,cli,expected,actual] of [['chat.members','config/dws/chat-members-list.schema.json','chat +chat-members-list',contract.schemaHash,input.groupMembersSchemaHash],['chat.info','config/dws/chat-conversation-info.schema.json','chat +conversation-info',contract.independentInfoSchemaHash,input.groupInfoSchemaHash]] as const){
  const entry=lock.commands[key],schema=JSON.parse(await readFile(path,'utf8'));
  if(!entry||entry.schemaFile!==path||entry.sourceCommit!==lock.sourceCommit||entry.schemaHash!==expected||actual!==expected||rpcHash(schema)!==expected||schema.cli_path!==cli||schema.effect!=='read'||schema.confirmation!=='not_required')throw new DwsError('DWS_GROUP_BINDING_UNCERTIFIED');
 }
}
