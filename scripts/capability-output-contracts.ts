import type {ResultContract} from '../packages/contracts/src/result-contract.js';
import {nativeArtifactResultContract} from '../packages/artifacts/src/native-contracts.js';
import {agentTextResultContract} from '../packages/company/src/agent-result.js';
import {groupCaseReadResultContract} from '../packages/groups/src/read-capability.js';
import {companyLogsResultContract} from '../packages/company/src/log-result-contract.js';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonical} from '../packages/gateway/src/index.js';
import {taskResultContract} from '../packages/runtime/src/task-result-contract.js';
import {attachmentInspectResultContract,attachmentTextResultContract} from '../packages/attachments/src/result-contracts.js';
import {companySearchResultContract,companyReadResultContract} from '../packages/company/src/result-contracts.js';
import {dwsConnectionResultContract,dwsContactResultContract,dwsDocumentResultContract} from '../packages/dws/src/result-contracts.js';
export const currentOutputContracts:readonly(readonly[string,ResultContract])[]=[['artifacts.create',nativeArtifactResultContract],['company.agent.ask',agentTextResultContract],['group.case.list',groupCaseReadResultContract],['tasks.get',taskResultContract],['attachments.inspect',attachmentInspectResultContract],['attachments.read_text',attachmentTextResultContract],['company.code.search',companySearchResultContract],['company.code.read',companyReadResultContract],['company.logs.query',companyLogsResultContract],['dws.connection.status',dwsConnectionResultContract],['dws.contact.me',dwsContactResultContract],['dws.doc.read',dwsDocumentResultContract]] as const;
export function outputContractManifest(){return {schemaVersion:1,meaning:'Reviewed anthys result projections; not provider endpoint schemas, permission grants or live certification',capabilities:currentOutputContracts.map(([id,c])=>({id,version:'1.0.0',outputSchemaHash:createHash('sha256').update(canonical(c.outputSchema)).digest('hex'),outputSchema:c.outputSchema})).sort((a,b)=>a.id.localeCompare(b.id,'en'))};}
if(import.meta.url===new URL(process.argv[1]??'', 'file://'+process.cwd()+'/').href){
 const mode=process.argv[2];if(process.argv.length===2||mode==='--help'&&process.argv.length===3)console.log('capability-output-contracts --check | --write. Offline projection manifest only; no .env, database or provider operation.');
 else if(process.argv.length!==3||!['--check','--write'].includes(mode!))throw Error('OUTPUT_CONTRACT_MODE_REQUIRED');
 else{const serialized=JSON.stringify(outputContractManifest(),null,2)+'\n',path='config/capability-output-contracts.json';if(mode==='--write')await writeFile(path,serialized);else if(await readFile(path,'utf8')!==serialized)throw Error('OUTPUT_CONTRACT_MANIFEST_STALE');console.log(JSON.stringify({status:'PASS',mode,capabilities:currentOutputContracts.length,databaseAccess:false,live:false}));}
}
