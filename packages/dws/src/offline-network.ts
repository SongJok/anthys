import {readFile,readdir} from 'node:fs/promises';
import {DwsError} from './contracts.js';

const capNames=['CapInh','CapPrm','CapEff','CapBnd','CapAmb'] as const;
export type OfflineNetworkObservation={devices:{name:string;flags:number}[];ipv4Routes:string;ipv6Routes:string;capabilitySets:Record<typeof capNames[number],string>;noNewPrivs:number};
// Linux IFF_UP=1 and IFF_LOOPBACK=8, include/uapi/linux/if.h. Default DOWN
// tunnel devices can exist in a network=none namespace; names alone prove
// neither connectivity nor isolation. The runtime must also drop all caps.
export function assertOfflineNetwork(value:OfflineNetworkObservation){
 const fail=()=>{throw new DwsError('DWS_RPC_OFFLINE_NETWORK_REQUIRED');};
 if(!value.devices.length||new Set(value.devices.map(d=>d.name)).size!==value.devices.length||!value.devices.some(d=>d.name==='lo')||value.noNewPrivs!==1||capNames.some(name=>!/^[a-f0-9]{16}$/i.test(value.capabilitySets[name])||BigInt('0x'+value.capabilitySets[name])!==0n))fail();
 for(const d of value.devices){if(!Number.isSafeInteger(d.flags)||d.flags<0||d.flags>0xffffffff||!d.name||d.name!=='lo'&&(d.flags&1)!==0||d.name==='lo'&&(d.flags&8)===0)fail();}
 const v4=value.ipv4Routes.trim().split('\n');if(!/^Iface\s+Destination\s+Gateway\s+Flags\b/.test(v4[0]??''))fail();for(const row of v4.slice(1)){const fields=row.trim().split(/\s+/);if(fields.length!==11||fields[0]!=='lo')fail();}
 for(const row of value.ipv6Routes.trim().split('\n').filter(Boolean)){const fields=row.trim().split(/\s+/);if(fields.length!==10||fields[9]!=='lo'||!fields.slice(0,9).every(f=>/^[a-f0-9]+$/i.test(f)))fail();}
}
type ReadNetworkFile=(path:string)=>Promise<string>;
export async function observeOfflineNetwork(read:ReadNetworkFile=path=>readFile(path,'utf8'),list:()=>Promise<string[]>=()=>readdir('/sys/class/net')):Promise<OfflineNetworkObservation>{
 try{const names=await list(),devices=[];for(const name of names){if(name==='bonding_masters')continue;const raw=(await read('/sys/class/net/'+name+'/flags')).trim();if(!/^0x[a-f0-9]+$/i.test(raw))throw Error();devices.push({name,flags:Number.parseInt(raw.slice(2),16)});}const status=await read('/proc/self/status'),capabilitySets={} as OfflineNetworkObservation['capabilitySets'];for(const name of capNames){const raw=status.match(new RegExp('^'+name+':\\s+([a-f0-9]+)$','im'))?.[1];if(!raw)throw Error();capabilitySets[name]=raw;}const noNewPrivs=Number(status.match(/^NoNewPrivs:\s+([01])$/m)?.[1]);const observation={devices,ipv4Routes:await read('/proc/net/route'),ipv6Routes:await read('/proc/net/ipv6_route'),capabilitySets,noNewPrivs};assertOfflineNetwork(observation);return observation;}catch{throw new DwsError('DWS_RPC_OFFLINE_NETWORK_REQUIRED');}
}
