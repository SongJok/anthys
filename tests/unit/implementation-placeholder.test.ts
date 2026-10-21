import {readFile} from 'node:fs/promises';
import {hasImplementationPlaceholder} from '../../scripts/implementation-placeholder.js';

it.each([
 'function missing(){return undefined;}',
 'const missing=()=>{return undefined;};',
 'const missing=function(){console.log("not finished");return undefined;};',
 'class Missing{execute(){return undefined;}}',
 'class Missing{get value(){return undefined;}}',
 'function missing(ok:boolean){if(ok)return undefined;return undefined;}',
 'function outer(){function unrelated(){return 42;}return undefined;}',
 'function outer(){function missing(){return undefined;}return missing();}',
 '// TODO implement the actual data path\nfunction missing(){return 42;}',
 'function missing(){throw new Error("Not implemented: data path");}',
])('retains a real placeholder refusal: %s',source=>{
 expect(hasImplementationPlaceholder(source)).toBe(true);
});
it.each([
 'function lookup(rows:string[],name:string){for(const row of rows){if(row===name)return row;}return undefined;}',
 'function lookup(found:boolean){if(!found)return undefined;return "present";}',
 'function lookup(){// return undefined; is documentation\nreturn "present";}',
 'function quote(){return "return undefined;";}',
])('does not confuse implemented lookup or inert text with an undefined-only stub: %s',source=>{
 expect(hasImplementationPlaceholder(source)).toBe(false);
});
it('recognizes the actual bounded SFNT table lookup instead of exempting a path',async()=>{
 const source=await readFile('packages/artifacts/src/font.ts','utf8');
 expect(source).toContain('return undefined;');
 expect(hasImplementationPlaceholder(source,'packages/artifacts/src/font.ts')).toBe(false);
 expect(hasImplementationPlaceholder('function table(){return undefined;}','packages/artifacts/src/font.ts')).toBe(true);
});
