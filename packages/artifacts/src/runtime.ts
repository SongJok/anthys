import type {Gateway} from '../../gateway/src/index.js';
import type {Vault} from '../../storage/src/crypto.js';
import type {FileStore} from '../../storage/src/files.js';
import type {ArtifactOptions} from './index.js';
import {NativeArtifactHost} from './native-host.js';
import {registerNativeArtifactCapability} from './native-capability.js';
/** Normal private-task runtime only. Existing trial/formal contracts never
 * inherit a capability from this registration or from an artifact receipt. */
export function registerNativeArtifacts(gateway:Gateway,vault:Vault,files:FileStore,fonts:Pick<ArtifactOptions,'limits'|'pdfFont'|'docxFont'>,mode:'DEFAULT'|'TRIAL'|'FORMAL'){
 if(mode!=='DEFAULT')return false;
 registerNativeArtifactCapability(gateway,new NativeArtifactHost(gateway,vault,files),fonts);return true;
}
