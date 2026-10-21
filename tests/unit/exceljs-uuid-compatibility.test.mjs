import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),excelRequire=createRequire(require.resolve('exceljs'));
const uuid=excelRequire('uuid'),ExcelJS=require('exceljs'),JSZip=excelRequire('jszip');
it('the exact ExcelJS dependency resolves the pinned patched CommonJS uuid package',()=>{
 expect(require('exceljs/package.json').version).toBe('4.4.0');expect(excelRequire('uuid/package.json').version).toBe('11.1.1');expect(excelRequire.resolve('uuid')).toMatch(/dist\/cjs\/index\.js$/);
});
it.each(['v3','v5','v6'])('GHSA-w5hq-g745-h8pq: %s rejects every out-of-range buffer before modifying any sentinel',name=>{
 const call=(buffer,offset)=>name==='v6'?uuid[name]({},buffer,offset):uuid[name]('synthetic','6ba7b810-9dad-11d1-80b4-00c04fd430c8',buffer,offset);
 for(const [length,offset] of [[8,4],[16,1],[16,-1]]){const buffer=new Uint8Array(length).fill(170);expect(()=>call(buffer,offset)).toThrow(RangeError);expect([...buffer]).toEqual(Array(length).fill(170));}
 const valid=new Uint8Array(32).fill(170);expect(call(valid,8)).toBe(valid);expect([...valid.slice(0,8)]).toEqual(Array(8).fill(170));expect([...valid.slice(24)]).toEqual(Array(8).fill(170));expect(uuid.version(uuid.stringify(valid,8))).toBe(Number(name.slice(1)));
});
it('real ExcelJS writes, loads and rewrites extended XLSX conditional rules with distinct valid v4 identifiers',async()=>{
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('Synthetic');sheet.addRows([['Value'],[1],[5],[9]]);sheet.getCell('A1').font={bold:true};sheet.getCell('C2').value={formula:'SUM(A2:A4)',result:15};
 sheet.addConditionalFormatting({ref:'A2:A4',rules:[{type:'dataBar',gradient:false,cfvo:[{type:'min'},{type:'max'}],color:{argb:'FF00AA00'}}]});sheet.addConditionalFormatting({ref:'A2:A4',rules:[{type:'iconSet',iconSet:'3Stars',cfvo:[{type:'percent',value:0},{type:'percent',value:33},{type:'percent',value:67}]}]});
 async function check(bytes){const zip=await JSZip.loadAsync(bytes),xml=await zip.file('xl/worksheets/sheet1.xml').async('string');expect(xml).toContain('<x14:dataBar');expect(xml).toContain('<x14:iconSet');const ids=[...xml.matchAll(/<x14:cfRule[^>]* id="\{([^}]+)\}"/g)].map(m=>m[1]);expect(ids).toHaveLength(2);expect(new Set(ids).size).toBe(2);for(const id of ids){expect(uuid.validate(id)).toBe(true);expect(uuid.version(id)).toBe(4);}}
 const first=await workbook.xlsx.writeBuffer();await check(first);const restored=new ExcelJS.Workbook();await restored.xlsx.load(first);const s=restored.getWorksheet('Synthetic');expect(s.getCell('A4').value).toBe(9);expect(s.getCell('A1').font.bold).toBe(true);expect(s.getCell('C2').value).toEqual({formula:'SUM(A2:A4)',result:15});const rules=s.conditionalFormattings.flatMap(i=>i.rules);expect(rules).toHaveLength(2);expect(rules.find(r=>r.type==='dataBar').gradient).toBe(false);expect(rules.find(r=>r.type==='iconSet').iconSet).toBe('3Stars');await check(await restored.xlsx.writeBuffer());
});
