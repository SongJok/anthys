import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
const [config,...rest]=process.argv.slice(2);if(!config||rest.length||!isAbsolute(config))throw Error('USAGE: start-dws-runner /absolute/private/config.json');
// No project .env, database, model, DingTalk app or MCP credential is passed.
const child=spawn(process.execPath,['dist/apps/dws-runner/src/main.js',config],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:'inherit',shell:false});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.once('error',()=>{process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
