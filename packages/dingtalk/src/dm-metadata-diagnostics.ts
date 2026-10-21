import {z} from 'zod';
export const dmDiagnosticReasons=['inactive','envelope','frame_size','json','forbidden_payload','body_shape','not_private','chatbot_corp','sender_corp','staff','robot','self_robot','nonce_format','nonce_value','time'] as const;
export type DmDiagnosticReason=typeof dmDiagnosticReasons[number];
const count=z.number().int().min(0).max(1000000),flag=z.boolean();
export const dmDiagnosticSnapshotSchema=z.object({schemaVersion:z.literal(1),sdkVersion:z.literal('2.1.5'),sequence:z.number().int().min(0).max(129),truncated:flag,webSocketOpenSeen:flag,readyConnectedFlag:flag,registeredSeen:flag,socketCloseSeen:flag,socketObservationAttached:flag,downstreamFrames:count,dispatchErrors:count,callbacks:count,topicCallbacks:count,listenerCallbacks:count,accepted:z.number().int().min(0).max(1),protocolAckCalls:z.number().int().min(0).max(1),protocolAckErrors:z.number().int().min(0).max(1),rejected:z.object({inactive:count,envelope:count,frame_size:count,json:count,forbidden_payload:count,body_shape:count,not_private:count,chatbot_corp:count,sender_corp:count,staff:count,robot:count,self_robot:count,nonce_format:count,nonce_value:count,time:count}).strict()}).strict().superRefine((s,c)=>{if(s.topicCallbacks>s.callbacks||s.protocolAckErrors>s.protocolAckCalls)c.addIssue({code:'custom',message:'DIAGNOSTIC_COUNTS_INVALID'});});
export type DmDiagnosticSnapshot=z.infer<typeof dmDiagnosticSnapshotSchema>;
export const dmDiagnosticEnvelopeSchema=z.object({kind:z.literal('DIAGNOSTICS'),snapshot:dmDiagnosticSnapshotSchema}).strict();
/** Counters receive only fixed keys/booleans, never callback content or IDs. */
export class DmDiagnosticCounters{
 private readonly value:DmDiagnosticSnapshot={schemaVersion:1,sdkVersion:'2.1.5',sequence:0,truncated:false,webSocketOpenSeen:false,readyConnectedFlag:false,registeredSeen:false,socketCloseSeen:false,socketObservationAttached:false,downstreamFrames:0,dispatchErrors:0,callbacks:0,topicCallbacks:0,listenerCallbacks:0,accepted:0,protocolAckCalls:0,protocolAckErrors:0,rejected:{inactive:0,envelope:0,frame_size:0,json:0,forbidden_payload:0,body_shape:0,not_private:0,chatbot_corp:0,sender_corp:0,staff:0,robot:0,self_robot:0,nonce_format:0,nonce_value:0,time:0}};
 increment(key:'downstreamFrames'|'dispatchErrors'|'callbacks'|'topicCallbacks'|'listenerCallbacks'|'accepted'|'protocolAckCalls'|'protocolAckErrors'){const max=['accepted','protocolAckCalls','protocolAckErrors'].includes(key)?1:1000000;if(this.value[key]>=max)this.value.truncated=true;else this.value[key]++;}
 mark(key:'webSocketOpenSeen'|'readyConnectedFlag'|'registeredSeen'|'socketCloseSeen'|'socketObservationAttached'|'truncated'){this.value[key]=true;}
 reject(reason:DmDiagnosticReason){if(this.value.rejected[reason]>=1000000)this.value.truncated=true;else this.value.rejected[reason]++;}
 snapshot(sequence=0):DmDiagnosticSnapshot{return dmDiagnosticSnapshotSchema.parse({...this.value,sequence,rejected:{...this.value.rejected}});}
}
