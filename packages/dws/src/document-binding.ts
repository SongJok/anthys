import {readFile} from 'node:fs/promises';
import {rpcHash} from './signed-protocol.js';
import {DwsError} from './contracts.js';
export type DocumentBindingInput={binaryHash:string;schemaHash:string;documentSchemaHash:string};
// Verify archived CLI metadata only. The opaque upstream mapping and current
// owner/resource authorization are still required; this enables no live egress.
export async function assertReviewedDocumentReadBinding(input:DocumentBindingInput,platform:string){
 const lock=JSON.parse(await readFile('config/dws/lock.json','utf8')),contract=JSON.parse(await readFile('config/dws/document-contract.json','utf8')),path='config/dws/doc-fetch.schema.json',entry=lock.commands['doc.fetch'],schema=JSON.parse(await readFile(path,'utf8'));
 if(contract.cliVersion!==lock.version||contract.sourceCommit!==lock.sourceCommit||input.binaryHash!==lock.platforms[platform]?.binarySha256||input.schemaHash!==lock.commands['contact.me']?.schemaHash||!entry||entry.schemaFile!==path||input.documentSchemaHash!==entry.schemaHash||rpcHash(schema)!==entry.schemaHash||schema.cli_path!=='doc +fetch'||schema.effect!=='read'||schema.confirmation!=='not_required')throw new DwsError('DWS_DOCUMENT_BINDING_UNCERTIFIED');
}
