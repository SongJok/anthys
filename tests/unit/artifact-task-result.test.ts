import {describe,it,expect} from 'vitest';
import {taskResultArtifactRequest} from '../../packages/artifacts/src/task-result.js';
import {renderArtifact} from '../../packages/artifacts/src/index.js';
const source={verification:'UNVERIFIED',asOf:'2026-10-19T00:00:00.000Z',notice:'Only the original authorized task scope; no external completion verified.'} as const;
const result='900719925474099312345\r\n0.000000000000000000001\r\n=HYPERLINK("https://invalid.example")\r\nUNKNOWN: deployment version unverified';
describe('authorized task result projection, no authority inferred from rendering',()=>{
 it.each(['md','txt','json','html'] as const)('preserves exact prose lines and uncertainty for %s',async format=>{
  const request=taskResultArtifactRequest({format,title:'Original task',result,source});
  expect(request.paragraphs.slice(1)).toEqual(result.split('\r\n'));
  expect(request.paragraphs[0]).toContain('UNVERIFIED');
  const rendered=await renderArtifact(request);expect(rendered.bytes.length).toBeGreaterThan(0);
  expect(rendered.bytes.toString()).toContain('900719925474099312345');
  // Markdown escapes punctuation; compare the represented decimal without
  // requiring its source syntax to be identical to plain text.
  expect(rendered.bytes.toString()).toContain(format==='md'?'0\\.000000000000000000001':'0.000000000000000000001');
  expect(rendered.bytes.toString()).toContain('UNKNOWN: deployment version unverified');
 });
 it.each(['csv','xlsx'] as const)('projects %s into numbered text lines without interpreting numbers/formulas',async format=>{
  const request=taskResultArtifactRequest({format,title:'Original task',result,source});
  expect(request.paragraphs).toEqual([]);expect(request.table?.columns).toEqual([{name:'line',type:'integer'},{name:'content',type:'text'}]);
  expect(request.table?.rows.slice(1)).toEqual(result.split('\r\n').map((s,i)=>[i+1,s]));
  const rendered=await renderArtifact(request);expect(rendered.inspection.formulaCells).toBe(0);expect(rendered.inspection.externalRelationships).toBe(0);
 });
 it('rejects overflow rather than silently dropping lines, and accepts the exact line bound',()=>{
  expect(taskResultArtifactRequest({format:'txt',title:'Task',result:Array(997).fill('line').join('\n'),source}).paragraphs).toHaveLength(998);
  for(const value of [Array(998).fill('line').join('\n'),'x'.repeat(16385),'   '])expect(()=>taskResultArtifactRequest({format:'txt',title:'Task',result:value,source})).toThrow('ARTIFACT_RESULT_LIMIT');
 });
 it('rejects client-supplied authority, paths, result replacements and unsupported formats',()=>{
  const base={format:'txt',title:'Task',result,source};
  for(const patch of [{ownerId:'other'},{path:'/tmp/output'},{downloadUrl:'https://invalid.example'},{format:'zip'},{source:{...source,authorized:true}}])expect(()=>taskResultArtifactRequest({...base,...patch})).toThrow();
 });
});
