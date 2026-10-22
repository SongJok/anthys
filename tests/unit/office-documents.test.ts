import {DocumentEditor,type DocumentConnector} from '../../packages/office/src/documents.js';

const nodeId='doc-synthetic-1',baseText='Alpha\nBeta\nGamma\n',now=Date.parse('2026-10-21T00:00:00.000Z');
const edit={nodeId,expectedRevision:'7',replacements:[{find:'Beta',replace:'Beta reviewed'}]};
class SyntheticDocuments implements DocumentConnector{
 doc={nodeId,revision:'7',text:baseText};updates:Parameters<DocumentConnector['update']>[0][]=[];reads=0;failRead=false;failUpdate=false;failReadAfterUpdate=false;mutateRead:((doc:{nodeId:string;revision:string;text:string})=>typeof doc)|undefined;updated=false;
 private view(doc:{nodeId:string;revision:string;text:string}){return this.mutateRead?this.mutateRead({...doc}):doc;}
 async read(_input:{nodeId:string}){this.reads++;if(this.failRead||this.updated&&this.failReadAfterUpdate)throw Error('SYNTHETIC_READ_FAILED');return this.view(this.doc);}
 async update(input:Parameters<DocumentConnector['update']>[0]){this.updates.push(input);if(this.failUpdate)throw Error('SYNTHETIC_UPDATE_FAILED');if(input.expectedRevision!==this.doc.revision)throw Error('SYNTHETIC_VERSION_CONFLICT');this.doc={...this.doc,text:input.text,revision:String(Number(this.doc.revision)+1)};this.updated=true;return {nodeId:this.doc.nodeId,revision:this.doc.revision};}
}

it('T114 proposes without writing and applies an edit only after the fresh revision is read back',async()=>{
 const connector=new SyntheticDocuments(),editor=new DocumentEditor({connector,now:()=>now});
 const proposal=await editor.proposeEdit(edit,new AbortController().signal);
 expect(proposal).toMatchObject({status:'PROPOSED_EDIT',nodeId,baseRevision:'7',replacements:edit.replacements,expiresAt:new Date(now+300_000).toISOString()});
 expect(connector.updates).toHaveLength(0);expect(connector.reads).toBe(1);
 if(proposal.status!=='PROPOSED_EDIT')throw Error(proposal.status);
 const result=await editor.confirm(proposal.proposalId,new AbortController().signal);
 expect(result).toMatchObject({status:'VERIFIED',nodeId,revision:'8',mode:'DIRECT',preservedExternalChanges:false});
 if(result.status==='VERIFIED')expect(result.textHash).toMatch(/^[a-f0-9]{64}$/);
 expect(connector.doc.text).toBe('Alpha\nBeta reviewed\nGamma\n');
 expect(connector.updates).toEqual([{nodeId,expectedRevision:'7',text:'Alpha\nBeta reviewed\nGamma\n',requestHash:(proposal as {requestHash:string}).requestHash}]);
 expect(await editor.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'DOCUMENT_PROPOSAL_UNKNOWN'});
 expect(connector.updates).toHaveLength(1);
});

it('merges an edit onto a newer revision without overwriting an unrelated external change',async()=>{
 const connector=new SyntheticDocuments(),editor=new DocumentEditor({connector,now:()=>now});
 const proposal=await editor.proposeEdit(edit,new AbortController().signal);if(proposal.status!=='PROPOSED_EDIT')throw Error(proposal.status);
 connector.doc={...connector.doc,text:'Alpha\nBeta\nGamma\nDelta\n',revision:'8'};
 const result=await editor.confirm(proposal.proposalId,new AbortController().signal);
 expect(result).toMatchObject({status:'VERIFIED',nodeId,revision:'9',mode:'MERGED',preservedExternalChanges:true});
 expect(connector.doc.text).toBe('Alpha\nBeta reviewed\nGamma\nDelta\n');
 expect(connector.updates[0]).toMatchObject({expectedRevision:'8',text:'Alpha\nBeta reviewed\nGamma\nDelta\n'});
});

it('reports a conflict instead of overwriting when the edited anchor vanished or became ambiguous',async()=>{
 const vanished=new SyntheticDocuments(),first=new DocumentEditor({connector:vanished,now:()=>now});
 const proposal=await first.proposeEdit(edit,new AbortController().signal);if(proposal.status!=='PROPOSED_EDIT')throw Error(proposal.status);
 vanished.doc={...vanished.doc,text:'Alpha\nBeta changed by someone else\nGamma\n',revision:'8'};
 expect(await first.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'CONFLICT',code:'DOCUMENT_EDIT_CONFLICT',currentRevision:'8',effect:'NONE'});
 expect(vanished.updates).toHaveLength(0);
 const ambiguous=new SyntheticDocuments(),second=new DocumentEditor({connector:ambiguous,now:()=>now});
 const other=await second.proposeEdit(edit,new AbortController().signal);if(other.status!=='PROPOSED_EDIT')throw Error(other.status);
 ambiguous.doc={...ambiguous.doc,text:'Alpha\nBeta\nGamma\nBeta\n',revision:'8'};
 expect(await second.confirm(other.proposalId,new AbortController().signal)).toMatchObject({status:'CONFLICT',code:'DOCUMENT_EDIT_CONFLICT',currentRevision:'8'});
 expect(ambiguous.updates).toHaveLength(0);
});

it('rejects a stale expected revision at proposal time and overlapping anchors without any write',async()=>{
 const connector=new SyntheticDocuments(),editor=new DocumentEditor({connector,now:()=>now});
 connector.doc={...connector.doc,revision:'8'};
 expect(await editor.proposeEdit(edit,new AbortController().signal)).toMatchObject({status:'CONFLICT',code:'DOCUMENT_VERSION_CONFLICT',currentRevision:'8',effect:'NONE'});
 expect(connector.reads).toBe(1);expect(connector.updates).toHaveLength(0);
 connector.doc={...connector.doc,revision:'7'};
 expect(await editor.proposeEdit({...edit,replacements:[{find:'Alpha\nBeta',replace:'X'},{find:'Beta',replace:'Y'}]},new AbortController().signal)).toMatchObject({status:'CONFLICT',code:'DOCUMENT_EDIT_CONFLICT'});
 expect(connector.updates).toHaveLength(0);
});

it('defaults to blocked external and rejects invalid, unknown, expired or aborted proposals without writing',async()=>{
 expect(await new DocumentEditor({connector:null}).proposeEdit(edit,new AbortController().signal)).toMatchObject({status:'BLOCKED_EXTERNAL',code:'DOCUMENT_CONNECTOR_UNAVAILABLE'});
 const connector=new SyntheticDocuments();let clock=now;const editor=new DocumentEditor({connector,now:()=>clock,proposalTtlMs:1000});
 for(const invalid of [{...edit,nodeId:'bad node'},{...edit,expectedRevision:''},{...edit,replacements:[]},{...edit,replacements:[{find:'Beta',replace:'Beta'}]},{...edit,replacements:[{find:'Beta',replace:'X'},{find:'Beta',replace:'Y'}]},{...edit,replacements:[{find:'Beta',replace:'bad\u0000text'}]},{...edit,extra:true}]){
  expect(await editor.proposeEdit(invalid,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'DOCUMENT_REQUEST_INVALID'});
 }
 const abort=new AbortController();abort.abort();
 expect(await editor.proposeEdit(edit,abort.signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'DOCUMENT_REQUEST_INVALID'});
 expect(await editor.confirm('unknown',new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'DOCUMENT_PROPOSAL_UNKNOWN'});
 const proposal=await editor.proposeEdit(edit,new AbortController().signal);if(proposal.status!=='PROPOSED_EDIT')throw Error(proposal.status);
 const aborted=new AbortController();aborted.abort();
 expect(await editor.confirm(proposal.proposalId,aborted.signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'DOCUMENT_REQUEST_INVALID'});
 clock=now+1000;
 expect(await editor.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'INVALID_PROPOSAL',code:'DOCUMENT_PROPOSAL_EXPIRED'});
 expect(connector.updates).toHaveLength(0);
});

it('never reports success for unreadable, failed or mismatched writes and read-backs',async()=>{
 const connector=new SyntheticDocuments(),editor=new DocumentEditor({connector,now:()=>now});
 connector.failRead=true;expect(await editor.proposeEdit(edit,new AbortController().signal)).toMatchObject({status:'READ_FAILED',code:'DOCUMENT_READ_UNAVAILABLE',effect:'NONE'});
 connector.failRead=false;const unreadable=await editor.proposeEdit(edit,new AbortController().signal);if(unreadable.status!=='PROPOSED_EDIT')throw Error(unreadable.status);
 connector.failRead=true;expect(await editor.confirm(unreadable.proposalId,new AbortController().signal)).toMatchObject({status:'READ_FAILED',code:'DOCUMENT_READ_UNAVAILABLE'});
 connector.failRead=false;
 const failing=await editor.proposeEdit(edit,new AbortController().signal);if(failing.status!=='PROPOSED_EDIT')throw Error(failing.status);
 connector.failUpdate=true;expect(await editor.confirm(failing.proposalId,new AbortController().signal)).toMatchObject({status:'UNKNOWN',code:'DOCUMENT_UPDATE_OUTCOME_UNKNOWN',effect:'UNKNOWN'});
 connector.failUpdate=false;
 const proposal=await editor.proposeEdit(edit,new AbortController().signal);if(proposal.status!=='PROPOSED_EDIT')throw Error(proposal.status);
 connector.failReadAfterUpdate=true;expect(await editor.confirm(proposal.proposalId,new AbortController().signal)).toMatchObject({status:'VERIFICATION_FAILED',code:'DOCUMENT_READBACK_UNAVAILABLE',nodeId,effect:'UNKNOWN'});
 const mismatch=new SyntheticDocuments(),second=new DocumentEditor({connector:mismatch,now:()=>now});
 const next=await second.proposeEdit(edit,new AbortController().signal);if(next.status!=='PROPOSED_EDIT')throw Error(next.status);
 mismatch.mutateRead=doc=>mismatch.updated?{...doc,text:'tampered'}:doc;
 expect(await second.confirm(next.proposalId,new AbortController().signal)).toMatchObject({status:'VERIFICATION_FAILED',code:'DOCUMENT_READBACK_MISMATCH',nodeId,effect:'UNKNOWN'});
});

it('reads one bounded document and rejects invalid or unavailable responses',async()=>{
 const connector=new SyntheticDocuments(),editor=new DocumentEditor({connector,now:()=>now});
 expect(await editor.read({nodeId},new AbortController().signal)).toMatchObject({status:'READ',nodeId,revision:'7',text:baseText});
 expect(await editor.read({nodeId:'bad node'},new AbortController().signal)).toMatchObject({status:'READ_FAILED',code:'DOCUMENT_REQUEST_INVALID',effect:'NONE'});
 const abort=new AbortController();abort.abort();
 expect(await editor.read({nodeId},abort.signal)).toMatchObject({status:'READ_FAILED',code:'DOCUMENT_REQUEST_INVALID'});
 connector.failRead=true;expect(await editor.read({nodeId},new AbortController().signal)).toMatchObject({status:'READ_FAILED',code:'DOCUMENT_READ_UNAVAILABLE'});
 connector.failRead=false;connector.mutateRead=doc=>({...doc,nodeId:'other'});
 expect(await editor.read({nodeId},new AbortController().signal)).toMatchObject({status:'READ_FAILED',code:'DOCUMENT_READ_INVALID'});
 connector.mutateRead=doc=>({...doc,text:'x'.repeat(12001)});
 expect(await editor.read({nodeId},new AbortController().signal)).toMatchObject({status:'READ_FAILED',code:'DOCUMENT_READ_INVALID'});
 expect(connector.updates).toHaveLength(0);
});
