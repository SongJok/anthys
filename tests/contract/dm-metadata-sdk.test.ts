import {DmDiagnosticCounters} from '../../packages/dingtalk/src/dm-metadata-diagnostics.js';
import {observeDmMetadataClient} from '../../packages/dingtalk/src/dm-metadata-sdk.js';
import {EventEmitter} from 'node:events';
import {DWClient,TOPIC_ROBOT} from 'dingtalk-stream';
import {createDmMetadataClient} from '../../packages/dingtalk/src/dm-metadata-sdk.js';
import {DM_CAPTURE_TOPIC} from '../../packages/dingtalk/src/dm-metadata.js';
it('the pinned SDK effective config contains only robot CALLBACK and cannot reconnect',()=>{
 const client=createDmMetadataClient({clientId:'synthetic-client',clientSecret:'synthetic-secret'},()=>{});expect(client.config.autoReconnect).toBe(false);expect(client.config.subscriptions).toEqual([{type:'CALLBACK',topic:TOPIC_ROBOT}]);expect(DM_CAPTURE_TOPIC).toBe(TOPIC_ROBOT);expect(client.config.debug).toBe(false);expect(client.config.keepAlive).toBe(false);
 const copy=client.getConfig();copy.autoReconnect=true;expect(client.config.autoReconnect).toBe(false);expect(client.connected).toBe(false);
});
it('dedicated subscriptions do not mutate the shared default EVENT array or another client',()=>{
 const ordinary=new DWClient({clientId:'synthetic-ordinary',clientSecret:'synthetic-secret'}),before=structuredClone(ordinary.config.subscriptions),first=createDmMetadataClient({clientId:'one',clientSecret:'synthetic'},()=>{}),second=createDmMetadataClient({clientId:'two',clientSecret:'synthetic'},()=>{});expect(ordinary.config.subscriptions).toEqual(before);expect(before.some(x=>x.type==='EVENT'&&x.topic==='*')).toBe(true);expect(first.config.subscriptions).not.toBe(second.config.subscriptions);
});
it('even an unexpected unsubscribed EVENT cannot inherit a business SUCCESS acknowledgement',()=>{
 const client=createDmMetadataClient({clientId:'synthetic',clientSecret:'synthetic'},()=>{}),send=vi.fn();client.send=send;expect(()=>client.onEvent({} as never)).toThrow('DM_CAPTURE_UNEXPECTED_EVENT');expect(send).not.toHaveBeenCalled();
});

it('diagnostic observation forwards SDK raw dispatch, distinguishes topic filters and adds no acknowledgement',async()=>{
 const values:unknown[]=[],client=createDmMetadataClient({clientId:'synthetic',clientSecret:'PRIVATE_CREDENTIAL_CANARY'},v=>values.push(v)),send=vi.fn(),counts=new DmDiagnosticCounters(),snapshots:unknown[]=[];client.send=send;
 const socket=new EventEmitter();client._connect=async()=>{Reflect.set(client,'socket',socket);await Promise.resolve();socket.emit('open');client.connected=true;};observeDmMetadataClient(client,counts,()=>snapshots.push(counts.snapshot()));
 await client._connect();expect(counts.snapshot()).toMatchObject({webSocketOpenSeen:true,socketObservationAttached:true,registeredSeen:false});
 const value={type:'CALLBACK',headers:{topic:TOPIC_ROBOT,messageId:'PRIVATE_MESSAGE_ID_CANARY'},data:'PRIVATE_BODY_CANARY'};client.onDownStream(JSON.stringify(value));client.onDownStream(JSON.stringify({...value,headers:{...value.headers,topic:'PRIVATE_OTHER_TOPIC_CANARY'}}));
 client.onDownStream(JSON.stringify({...value,type:'SYSTEM',headers:{...value.headers,topic:'REGISTERED'}}));socket.emit('close');expect(values).toEqual([value]);expect(send).not.toHaveBeenCalled();
 expect(counts.snapshot()).toMatchObject({downstreamFrames:3,callbacks:2,topicCallbacks:1,registeredSeen:true,socketCloseSeen:true});expect(JSON.stringify(snapshots)).not.toMatch(/PRIVATE_|synthetic|CALLBACK|OA_BIND/);
});
