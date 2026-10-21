import type {DmDiagnosticCounters} from './dm-metadata-diagnostics.js';
import {DWClient,type DWClientDownStream} from 'dingtalk-stream';
import {DM_CAPTURE_TOPIC} from './dm-metadata.js';
import {DmCaptureError} from './dm-metadata-file.js';
// Imported only by the owned live child (or explicit offline SDK contract tests).
export function createDmMetadataClient(credentials:{clientId:string;clientSecret:string},callback:(message:DWClientDownStream)=>void):DWClient {
 const client=new DWClient({...credentials,debug:false,keepAlive:false});
 // getConfig returns a copy. The pinned SDK exposes its actual config object.
 client.config.autoReconnect=false;client.config.subscriptions=[];
 client.registerCallbackListener(DM_CAPTURE_TOPIC,callback);
 // Unsubscribed business events must never inherit the SDK's default SUCCESS ACK.
 client.onEvent=()=>{throw new DmCaptureError('DM_CAPTURE_UNEXPECTED_EVENT');};
 const actual=client.config;if(actual.autoReconnect!==false||actual.subscriptions.length!==1||actual.subscriptions[0]?.type!=='CALLBACK'||actual.subscriptions[0]?.topic!==DM_CAPTURE_TOPIC)throw new DmCaptureError('DM_CAPTURE_SDK_CONFIGURATION_INVALID');
 return client;
}

/** Observe SDK dispatch unchanged; emit fixed counters only, with no new ACK. */
export function observeDmMetadataClient(client:DWClient,counts:DmDiagnosticCounters,publish:()=>void):void{
 const downstream=client.onDownStream.bind(client),callback=client.onCallback.bind(client),system=client.onSystem.bind(client),connect=client._connect.bind(client);
 client.onDownStream=data=>{counts.increment('downstreamFrames');try{return downstream(data);}catch(error){counts.increment('dispatchErrors');throw error;}finally{publish();}};
 client.onCallback=message=>{counts.increment('callbacks');if(message?.headers?.topic===DM_CAPTURE_TOPIC)counts.increment('topicCallbacks');try{return callback(message);}finally{publish();}};
 client.onSystem=message=>{try{return system(message);}finally{if(message?.headers?.topic==='REGISTERED'&&client.registered)counts.mark('registeredSeen');publish();}};
 client._connect=()=>{const pending=connect(),socket=Reflect.get(client,'socket') as {once?:(event:string,listener:()=>void)=>unknown}|undefined;
  if(typeof socket?.once==='function'){counts.mark('socketObservationAttached');socket.once('open',()=>{counts.mark('webSocketOpenSeen');publish();});socket.once('close',()=>{counts.mark('socketCloseSeen');publish();});}return pending;
 };
}
