import {DwsError,type DwsState} from './contracts.js';
import type {SignedDwsReadClient} from './signed-client.js';
import {documentDelegationSchema,documentScopeSchema,documentTargetForScope,rpcHash,validateSignedDocumentObservation,type DwsDocumentDelegation,type DwsDocumentScope} from './signed-protocol.js';

/** Current owner authority belongs to the caller's real pre/post guards. */
export class SignedDocumentReader {
 constructor(private readonly client:SignedDwsReadClient){}
 async read(delegation:DwsDocumentDelegation,state:DwsState,scope:DwsDocumentScope,signal:AbortSignal){
  signal.throwIfAborted();
  const approved=documentScopeSchema.safeParse(scope);
  if(!approved.success)throw new DwsError('DWS_RPC_DOCUMENT_SCOPE_INVALID');
  const candidate=documentDelegationSchema.safeParse(delegation);
  if(!candidate.success||rpcHash(candidate.data)!==rpcHash(approved.data.delegation))throw new DwsError('DWS_RPC_SCOPE_MISMATCH');
  const target=documentTargetForScope(approved.data),result=await this.client.readDocument(candidate.data,state,target,signal);
  signal.throwIfAborted();
  if(result.grantsAuthority!==false)throw new DwsError('DWS_RPC_DOCUMENT_RESULT_INVALID');
  return {value:validateSignedDocumentObservation(result.value,target,approved.data.profile),state:result.state,grantsAuthority:false as const};
 }
}
