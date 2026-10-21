import './isolation.js';
import {secret} from '../../packages/config/src/index.js';
import {Database,type DbContext} from '../../packages/storage/src/database.js';
import {Vault} from '../../packages/storage/src/crypto.js';
import {DwsRunner,type DwsRunnerConfig} from '../../packages/dws/src/runner.js';
import {DwsIdentities} from '../../packages/dws/src/identity.js';
const [subject,config,version]=process.argv.slice(2),db=new Database(secret('RUNTIME_DATABASE_URL')!),vault=new Vault(new Map([['1',Buffer.from(secret('APP_MASTER_KEY')!,'hex')]]),'1');
try{const service=new DwsIdentities(db,vault,new DwsRunner(JSON.parse(config!) as DwsRunnerConfig));await service.readSelf(JSON.parse(subject!) as DbContext,Number(version),new AbortController().signal);process.stdout.write('SYNTHETIC_READ_FINISHED\n');}catch{process.exitCode=1;}finally{await db.close();}
