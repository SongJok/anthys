import {comparePostgresInventories,InventoryError,validatePostgresInventory,type PostgresInventory} from './postgres-inventory.js';

type Table=PostgresInventory['tables'][number];
type Sequence=PostgresInventory['sequences'][number];
type Named={schema:string;name:string};
type TableValue=Pick<Table,'rows'|'bytes'|'sha256'>;
type SequenceValue=Pick<Sequence,'lastValue'|'isCalled'>;
type Difference<T>={added:Array<Named&{restored:T}>;missing:Array<Named&{current:T}>;changed:Array<Named&{current:T;restored:T}>};
const key=(value:Named)=>JSON.stringify([value.schema,value.name]);
function indexed<T extends Named>(items:readonly T[]){
 const result=new Map<string,T>();
 for(const item of items){const id=key(item);if(result.has(id))throw new InventoryError('INVALID_INVENTORY');result.set(id,item);}
 return result;
}
function order(a:Named,b:Named){return a.schema<b.schema?-1:a.schema>b.schema?1:a.name<b.name?-1:a.name>b.name?1:0;}
function difference<T extends Named,V>(current:readonly T[],restored:readonly T[],value:(row:T)=>V):Difference<V>{
 const before=indexed(current),after=indexed(restored),result:Difference<V>={added:[],missing:[],changed:[]};
 for(const [id,row]of before){const other=after.get(id),name={schema:row.schema,name:row.name},left=value(row);if(!other)result.missing.push({...name,current:left});else{const right=value(other);if(JSON.stringify(left)!==JSON.stringify(right))result.changed.push({...name,current:left,restored:right});}}
 for(const [id,row]of after)if(!before.has(id))result.added.push({schema:row.schema,name:row.name,restored:value(row)});
 result.added.sort(order);result.missing.sort(order);result.changed.sort(order);return result;
}
const tableValue=(row:Table):TableValue=>({rows:row.rows,bytes:row.bytes,sha256:row.sha256});
const sequenceValue=(row:Sequence):SequenceValue=>({lastValue:row.lastValue,isCalled:row.isCalled});
const summary=(value:PostgresInventory)=>({contentFingerprint:value.contentFingerprint,capturedAt:value.capturedAt,migrationCount:value.migrationCount,schemaFingerprint:value.schemaFingerprint,metadataSha256:value.metadataSha256});

/** Pure comparison of supplied snapshots. "current" is a caller label, never a
 * verified claim of source freshness or authority. added/missing are relative
 * to current: added exists only in restored; missing exists only in current.
 * All tables and sequences participate, including unclassified business rows.
 * Inputs and lists are bounded by the existing Inventory schema (4096 each).
 */
export function compareRecoverySafety(currentRaw:unknown,restoredRaw:unknown){
 const current=validatePostgresInventory(currentRaw),restored=validatePostgresInventory(restoredRaw);
 const compared=comparePostgresInventories(current,restored);
 const tables=difference(current.tables,restored.tables,tableValue),sequences=difference(current.sequences,restored.sequences,sequenceValue);
 const migrationCountMatches=current.migrationCount===restored.migrationCount;
 return {
  schemaVersion:1 as const,kind:'POSTGRES_RECOVERY_SAFETY_COMPARISON' as const,
  status:compared.status==='MATCH'&&migrationCountMatches?'NO_DIFFERENCE_OBSERVED' as const:'DIFFERENCE_REQUIRES_RECONCILIATION' as const,
  current:summary(current),restored:summary(restored),
  schemaMatches:compared.schemaMatches&&migrationCountMatches,metadataMatches:compared.metadataMatches,migrationCountMatches,
  differenceDirection:'RESTORED_RELATIVE_TO_CURRENT' as const,
  tables:{matches:compared.dataMatches,...tables},sequences:{matches:compared.sequencesMatch,...sequences},
  externalDispatchResumeAuthorized:false as const,currentAuthorityFreshnessVerified:false as const,safetyFactsReplayed:false as const,revocationAndExternalStateReconciliationRequired:true as const,
 };
}
