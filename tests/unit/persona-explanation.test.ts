import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {randomUUID} from 'node:crypto';
import {PersonaContext} from '../../apps/web/src/persona-context.js';
import {personaContextExplanationSchema} from '../../packages/personas/src/explanation-schema.js';

const bound=()=>({state:'BOUND',checkedAt:new Date().toISOString(),snapshotId:randomUUID(),policyVersion:3,templateVersion:1,sources:[{kind:'GLOBAL',version:2},{kind:'USER',version:7}]});
const render=(value:unknown)=>renderToStaticMarkup(React.createElement(PersonaContext,{value}));
it('T037 component: frozen version metadata identifies actual layers without private preference content',()=>{
 const value=bound();expect(personaContextExplanationSchema.safeParse(value).success).toBe(true);const html=render(value);expect(html).toContain('企业默认：版本 2');expect(html).toContain('个人偏好：版本 7');expect(html).toContain('企业约束版本：3');expect(html).toContain('重试和会话恢复沿用原快照');expect(html).not.toContain(value.snapshotId);
});
it('group provenance never pretends to be a personal setting and zero means an unset layer',()=>{
 const value=bound();value.sources[1]={kind:'GROUP',version:0};const html=render(value);expect(html).toContain('群偏好：未设置，使用内置默认');expect(html).not.toContain('个人偏好：');
});
it.each(['UNBOUND','BUILTIN_ONLY','LEGACY_NONE','UNAVAILABLE'] as const)('renders the distinct %s persisted mode without claiming a bound version',state=>{
 const html=render({state});expect(html).not.toContain('企业约束版本：');expect(html).toContain({UNBOUND:'尚未固定',BUILTIN_ONLY:'固定使用内置默认',LEGACY_NONE:'旧运行未保存',UNAVAILABLE:'版本信息已隐藏'}[state]!);
});
it.each([undefined,{...bound(),fields:{address:'PRIVATE_STYLE_CANARY'}},{...bound(),sources:[{kind:'USER',version:9},{kind:'GLOBAL',version:1}]},{...bound(),policyVersion:-1},{state:'UNAVAILABLE',privateMemory:'PRIVATE_STYLE_CANARY'}])('unknown or extra body/hash/identity fields fail closed at the rendering boundary %#',value=>{
 expect(personaContextExplanationSchema.safeParse(value).success).toBe(false);const html=render(value);expect(html).toContain('版本信息已隐藏');expect(html).not.toContain('PRIVATE_STYLE_CANARY');expect(html).not.toContain('个人偏好：');
});
