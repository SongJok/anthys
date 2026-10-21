import {resolve,join} from 'node:path';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {readDmCaptureConfiguration} from '../../packages/dingtalk/src/dm-metadata-configuration.js';
import {runCaptureCli} from '../../scripts/capture-dm-metadata.js';
import {DmCaptureError} from '../../packages/dingtalk/src/dm-metadata-file.js';
let stdout='',stderr='';beforeEach(()=>{stdout='';stderr='';vi.spyOn(process.stdout,'write').mockImplementation(chunk=>{stdout+=String(chunk);return true;});vi.spyOn(process.stderr,'write').mockImplementation(chunk=>{stderr+=String(chunk);return true;});});afterEach(()=>vi.restoreAllMocks());
it.each([[],['--help']].map(args=>({args})))('default and help do not read any config or create any SDK/transport %#',async({args})=>{
 const readConfig=vi.fn(async()=>{throw Error('MUST_NOT_READ_CONFIG');}),makeTransport=vi.fn(()=>{throw Error('MUST_NOT_CREATE_TRANSPORT');});expect(await runCaptureCli(args,{readConfig,makeTransport})).toBe(0);expect(readConfig).not.toHaveBeenCalled();expect(makeTransport).not.toHaveBeenCalled();expect(stdout).toContain('--env-file');expect(stderr).toBe('');
});
it.each([['--live','--seconds','181'],['--live','--seconds','0'],['--live','--seconds','1.5'],['--live','--output','/tmp/unsafe.json'],['--live','--client-secret','RAW_SECRET_CANARY'],['--unknown'],['--live','--seconds'],['--live','--output'],['--live','--env-file']].map(args=>({args})))('invalid flags cause zero config or transport effects %#',async({args})=>{
 const readConfig=vi.fn(async()=>{throw Error('MUST_NOT_READ_CONFIG');}),makeTransport=vi.fn(()=>{throw Error('MUST_NOT_CREATE_TRANSPORT');});expect(await runCaptureCli(args,{readConfig,makeTransport})).toBe(64);expect(readConfig).not.toHaveBeenCalled();expect(makeTransport).not.toHaveBeenCalled();expect(stderr).toBe('DM_CAPTURE_USAGE\n');expect(stdout+stderr).not.toContain('RAW_SECRET_CANARY');
});
it('an explicit env path reaches only the selected reader and failure never starts a transport',async()=>{
 const readConfig=vi.fn(async()=>{throw new DmCaptureError('DM_CAPTURE_CONFIGURATION_INVALID');}),makeTransport=vi.fn(()=>{throw Error('MUST_NOT_START');});expect(await runCaptureCli(['--live','--env-file','synthetic.env'],{readConfig,makeTransport})).toBe(1);expect(readConfig).toHaveBeenCalledWith(resolve('synthetic.env'));expect(makeTransport).not.toHaveBeenCalled();expect(stderr).toBe('DM_CAPTURE_CONFIGURATION_INVALID\n');
});

it.each([
 {label:'empty corp',extra:'DINGTALK_CORP_ID=\n'},
 {label:'empty self',extra:'DINGTALK_STAFFID=\n'},
 {label:'empty robot',extra:'DINGTALK_ROBOT_CODE=\n'},
 {label:'invalid corp',extra:'DINGTALK_CORP_ID="bad\ncorp"\n'},
 {label:'invalid self',extra:'DINGTALK_STAFFID="bad\nself"\n'},
 {label:'invalid robot',extra:'DINGTALK_ROBOT_CODE="bad\nrobot"\n'},
 {label:'missing client id',extra:'DINGTALK_APP_KEY=\n'},
 {label:'missing client secret',extra:'DINGTALK_APP_SECRET=\n'},
 {label:'missing secret mount',extra:'DINGTALK_APP_SECRET_FILE=missing-secret\n'}
])('invalid selected config $label causes zero transport without reading real env',async({extra})=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'oa-dm-cli-config-'))),path=join(root,'fixture.env'),makeTransport=vi.fn(()=>{throw Error('MUST_NOT_CREATE_TRANSPORT');});
 try{await writeFile(path,'DINGTALK_CORP_ID=synthetic-corp\nDINGTALK_STAFFID=synthetic-self\nDINGTALK_ROBOT_CODE=synthetic-robot\nDINGTALK_APP_KEY=synthetic-id\nDINGTALK_APP_SECRET=SECRET_CANARY\n'+extra,{mode:0o600});expect(await runCaptureCli(['--live','--env-file',path],{readConfig:readDmCaptureConfiguration,makeTransport})).toBe(1);expect(makeTransport).not.toHaveBeenCalled();expect(stderr).toBe('DM_CAPTURE_CONFIGURATION_INVALID\n');expect(stdout+stderr).not.toContain('SECRET_CANARY');}finally{await rm(root,{recursive:true,force:true});}
});

const selectedNonce='0123456789abcdef0123456789abcdef';
it.each([
 ['--live','--nonce'],['--live','--nonce',''],
 ...['a'.repeat(31),'a'.repeat(33),'A'.repeat(32),'g'.repeat(32),' '+selectedNonce,selectedNonce+'\n',selectedNonce+'\0','$(touch /tmp/DM_NONCE_INJECTION_CANARY)','`touch /tmp/DM_NONCE_INJECTION_CANARY`',selectedNonce+';echo RAW_SECRET_CANARY','--diagnostics'].map(value=>['--live','--nonce',value]),
 ...[['--nonce',selectedNonce],['--seconds','1'],['--output','.data/dm-capture/synthetic.json'],['--env-file','synthetic.env'],['--diagnostics']].map(flag=>['--live',...flag,...flag]),
 ['--live','--live'],['--live','--nonce',selectedNonce,'--unknown'],['--live','--diagnostics','unexpected'],['--live','--nonce='+selectedNonce]
].map(args=>({args})))('preselected nonce malformed/duplicate/unknown arguments reject before configuration and transport %#',async({args})=>{
 const readConfig=vi.fn(async()=>{throw Error('MUST_NOT_READ_CONFIG');}),makeTransport=vi.fn(()=>{throw Error('MUST_NOT_CREATE_TRANSPORT');});
 expect(await runCaptureCli(args,{readConfig,makeTransport})).toBe(64);expect(readConfig).not.toHaveBeenCalled();expect(makeTransport).not.toHaveBeenCalled();expect(stderr).toBe('DM_CAPTURE_USAGE\n');expect(stdout).toBe('');expect(stderr).not.toMatch(/RAW_SECRET|DM_NONCE_INJECTION|012345/);
});
it('preselected nonce valid arguments do not print a challenge before SDK READY',async()=>{
 const readConfig=vi.fn(async()=>{throw new DmCaptureError('DM_CAPTURE_CONFIGURATION_INVALID');}),makeTransport=vi.fn(()=>{throw Error('MUST_NOT_CREATE_TRANSPORT');});
 expect(await runCaptureCli(['--live','--nonce',selectedNonce,'--diagnostics','--seconds','180','--output','.data/dm-capture/synthetic.json','--env-file','synthetic.env'],{readConfig,makeTransport})).toBe(1);expect(readConfig).toHaveBeenCalledWith(resolve('synthetic.env'));expect(makeTransport).not.toHaveBeenCalled();expect(stdout).toBe('');expect(stderr).toContain('DM_CAPTURE_CONFIGURATION_INVALID');expect(stderr).not.toContain(selectedNonce);
});
