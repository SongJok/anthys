export type Result='PASS'|'FAIL'|'ABSENT';
export type Check={id:string;result:Result;detail:string;evidence:Record<string,unknown>};
export type ContainerMount={target:string;source:string};
export type ContainerView={mounts:ContainerMount[];envNames:string[]};
export type Contract={count:number;last:string};
const socketPath='/var/run/docker.sock';
export const credentialPattern=/dingtalk|glm|dws|company/i;
// A socket on any service other than the broker, or on none at all, means the
// isolation claim is unproven; only the single-owner broker case passes.
export function socketIsolation(containers:Record<string,ContainerView|null>){
 const mounts:Record<string,string[]>={};
 for(const [service,container] of Object.entries(containers))if(container)mounts[service]=container.mounts.filter(m=>m.target===socketPath||m.source===socketPath).map(m=>m.target);
 const owners=Object.entries(mounts).filter(([,targets])=>targets.length).map(([service])=>service);
 return {isolated:owners.length===1&&owners[0]==='sandbox-broker',owners,mounts};
}
export function brokerCredentialLeaks(secretsMounted:string[],envNames:string[]):string[]{return [...secretsMounted,...envNames].filter(name=>credentialPattern.test(name));}
export function endpointFailures(endpoints:Record<string,{status:number}|{error:string}>):string[]{return Object.entries(endpoints).filter(([,value])=>'error'in value||(value as {status:number}).status!==200).map(([name])=>name);}
export function heartbeatHealthy(verdict:Record<string,unknown>):boolean{return verdict['live']===true&&verdict['stale']===false&&verdict['missing']===false;}
export function migrationAgreement(api:Contract|null,broker:Contract|null,database:number|null,lastMigration:string|null):boolean{return !!api&&!!broker&&database!==null&&api.count===database&&broker.count===database&&lastMigration===api.last;}
export function overallStatus(checks:Check[]):'PASS'|'FAIL'{return checks.every(c=>c.result==='PASS')?'PASS':'FAIL';}
