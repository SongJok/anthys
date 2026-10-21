import fc from 'fast-check';
import {authorize,type PolicyInput} from '../../packages/policy/src/index.js';
import {canonical,toolName} from '../../packages/gateway/src/index.js';
it('T036 policy unit component: independent conjunction matches 10000 inputs without invoking Gateway',()=>{
 const seed=20261014;let authorized=0,denied=0;
 fc.assert(fc.property(fc.record({identityActive:fc.boolean(),epochMatches:fc.boolean(),appReady:fc.boolean(),platformPermission:fc.boolean(),delegationValid:fc.boolean(),resourceAllowed:fc.boolean(),audienceAllowed:fc.boolean(),budgetAvailable:fc.boolean(),notExpired:fc.boolean(),notCancelled:fc.boolean(),killSwitch:fc.boolean(),approvalValid:fc.boolean(),risk:fc.constantFrom('READ','PERSONAL_WRITE','SHARED_WRITE','SENSITIVE','FORBIDDEN')}),raw=>{
  const p=raw as PolicyInput;
  const oracle=p.identityActive&&p.epochMatches&&p.appReady&&p.platformPermission&&p.delegationValid&&p.resourceAllowed&&p.audienceAllowed&&p.budgetAvailable&&p.notExpired&&p.notCancelled&&!p.killSwitch&&p.risk!=='FORBIDDEN'&&(p.risk==='READ'||p.approvalValid);
  expect(authorize(p).allowed).toBe(oracle);if(authorize(p).allowed) authorized++;else denied++;
 }),{numRuns:10000,seed});expect(denied).toBeGreaterThan(9000);expect(authorized).toBeLessThan(1000);
});
it('T029 approval hash canonicalization preserves semantic fields and changes on audience/version/identity',()=>{
 expect(canonical({z:1,a:{b:2,a:1}})).toBe(canonical({a:{a:1,b:2},z:1}));
 expect(canonical({audience:'a',version:'1',actor:'a'})).not.toBe(canonical({audience:'b',version:'1',actor:'a'}));
 expect(toolName('tasks.get','1.0.0')).toMatch(/^cap_[a-f0-9]{12}$/);expect(toolName('tasks.get','2.0.0')).not.toBe(toolName('tasks.get','1.0.0'));
});
