/** Isolated test dependency tooling. No Linux executable is invoked. */
export type LinuxNodeArchitecture='arm64'|'x64';
export interface LinuxNodeRuntimeMetadata{
 readonly schemaVersion:1;
 readonly version:'24.21.0';
 readonly platform:'linux';
 readonly architecture:LinuxNodeArchitecture;
 readonly binaryPath:string;
 readonly binarySha256:string;
 /** Fixed official release archive digest; not signature verification. */
 readonly sourceIntegrity:string;
}
export const linuxNodeRuntimePins:Readonly<Record<LinuxNodeArchitecture,Readonly<{binarySha256:string;sourceIntegrity:string}>>>;
/** Requires an explicit canonical private directory and exact architecture. */
export function prepareLinuxNodeRuntime(raw:unknown):Promise<LinuxNodeRuntimeMetadata>;
/** Format-only helper. Does not authenticate Node provenance. */
export function validateLinuxNodeElf(header:Buffer,totalBytes:number,architecture:LinuxNodeArchitecture):void;
/** Format-only helper. Preparation separately authenticates archive/binary pins. */
export function scanLinuxNodeTar(source:AsyncIterable<Uint8Array>,architecture:LinuxNodeArchitecture,onNodeChunk:(chunk:Buffer)=>unknown,signal?:AbortSignal):Promise<{bytes:number;sha256:string}>;
