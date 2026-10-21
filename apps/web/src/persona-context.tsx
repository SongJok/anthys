import React from 'react';
import {personaContextExplanationSchema} from '../../../packages/personas/src/explanation-schema.js';

export function PersonaContext({value}:{value:unknown}){
 const parsed=personaContextExplanationSchema.safeParse(value),context=parsed.success?parsed.data:{state:'UNAVAILABLE' as const};
 return <aside aria-label="本次运行的助理偏好"><h4>本次运行的助理偏好</h4>{context.state==='BOUND'?<>
  <ul>{context.sources.map(source=><li key={source.kind}>{{GLOBAL:'企业默认',USER:'个人偏好',GROUP:'群偏好'}[source.kind]}：{source.version===0?'未设置，使用内置默认':'版本 '+source.version}</li>)}</ul>
  <p>企业约束版本：{context.policyVersion} · 内置模板版本：{context.templateVersion}</p>
  <p>本次运行固定使用上述版本。修改偏好对新运行生效；重试和会话恢复沿用原快照，授权或来源失效时暂停使用。</p>
 </>:context.state==='UNBOUND'?<p>尚未固定偏好快照，将在运行开始时读取获准版本。</p>:context.state==='BUILTIN_ONLY'?<p>本次运行固定使用内置默认，后来保存的偏好不会替换本次记录。</p>:context.state==='LEGACY_NONE'?<p>旧运行未保存可核验的偏好快照，无法说明当时使用的版本。</p>:<p>偏好快照已失效或暂时无法核验，版本信息已隐藏。</p>}
 <p>助理偏好影响表达方式，不会增加工具或数据权限。</p></aside>;
}
