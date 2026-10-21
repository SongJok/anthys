import {runCaptureCli} from '../../scripts/capture-dm-metadata.js';
import {DmCaptureError} from '../../packages/dingtalk/src/dm-metadata-file.js';
const path='.data/dm-capture/identity-synthetic.json';let out='',err='';
beforeEach(()=>{out='';err='';vi.spyOn(process.stdout,'write').mockImplementation(chunk=>{out+=String(chunk);return true;});vi.spyOn(process.stderr,'write').mockImplementation(chunk=>{err+=String(chunk);return true;});});afterEach(()=>vi.restoreAllMocks());
it.each([
 ['--live','--identity-diagnostic-output'],['--live','--identity-diagnostic-output',''],
 ['--live','--identity-diagnostic-output','/tmp/unsafe.json'],['--live','--identity-diagnostic-output','.data/dm-capture/bad;name.json'],
 ['--live','--identity-diagnostic-output',path,'--identity-diagnostic-output',path],
 ['--live','--identity-diagnostic-output',path,'--output',path],['--live','--output','.data/dm-capture/metadata.json','--identity-diagnostic-output',path],
 ['--live','--identity-diagnostic-output',path,'--nonce','$(touch /tmp/IDENTITY_INJECTION_CANARY)'],
 ['--live','--identity-diagnostic-output',path,'--seconds','181'],['--live','--identity-diagnostic-output',path,'--unknown'],
 ['--identity-diagnostic-output',path],['--live','--identity-diagnostic']
].map(args=>({args})))('identity-mode malformed/duplicate/conflicting arguments reject64 with zero config or transport effects %#',async({args})=>{
 const readConfig=vi.fn(async()=>{throw Error('MUST_NOT_READ_CONFIG');}),makeTransport=vi.fn(()=>{throw Error('MUST_NOT_START');});expect(await runCaptureCli(args,{readConfig,makeTransport})).toBe(64);expect(readConfig).not.toHaveBeenCalled();expect(makeTransport).not.toHaveBeenCalled();expect(err).toBe('DM_CAPTURE_USAGE\n');expect(out).toBe('');
});
it('the explicit mode selects only its diagnostic transport and never prints identity or credential values on failure',async()=>{
 const config={identity:{corpId:'PRIVATE_CORP_CANARY',staffId:'PRIVATE_STAFF_CANARY',robotCode:'PRIVATE_ROBOT_CANARY'},credentials:{clientId:'PRIVATE_APP_CANARY',clientSecret:'PRIVATE_SECRET_CANARY'}},readConfig=vi.fn(async()=>config),makeTransport=vi.fn(()=>{throw new DmCaptureError('DM_CAPTURE_FAILED');});expect(await runCaptureCli(['--live','--identity-diagnostic-output',path,'--nonce','a'.repeat(32),'--diagnostics'],{readConfig,makeTransport})).toBe(1);expect(makeTransport).toHaveBeenCalledWith(config.credentials,'IDENTITY_DIAGNOSTIC');expect(out).toBe('');expect(err).not.toMatch(/PRIVATE_|nonceHash/);
});
