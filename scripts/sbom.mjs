import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
const components=new Map();
for(const entry of await readdir('node_modules/.pnpm')){
 const base=`node_modules/.pnpm/${entry}/node_modules`;
 let children;try{children=await readdir(base);}catch{continue;}
 for(const child of children){let names=child.startsWith('@')?(await readdir(`${base}/${child}`)).map(n=>`${child}/${n}`):[child];
  for(const name of names){try{const p=JSON.parse(await readFile(`${base}/${name}/package.json`,'utf8'));if(p.name&&p.version){const key=`${p.name}@${p.version}`;components.set(key,{type:'library','bom-ref':key,name:p.name,version:p.version,purl:`pkg:npm/${p.name.replace('@','%40')}@${p.version}`,...(typeof p.license==='string'?{licenses:[{expression:p.license}]}:{})});}}catch{ /* Linked directory may be metadata rather than a package. */ }}
 }
}
const lock=await readFile('pnpm-lock.yaml');
await writeFile('reports/sbom.cdx.json',JSON.stringify({bomFormat:'CycloneDX',specVersion:'1.6',serialNumber:`urn:uuid:${randomUUID()}`,version:1,metadata:{timestamp:new Date().toISOString(),component:{type:'application',name:'open_aider',version:'0.1.0'},properties:[{name:'pnpm-lock-sha256',value:createHash('sha256').update(lock).digest('hex')}]},components:[...components.values()].sort((a,b)=>a.name.localeCompare(b.name))},null,2)+'\n');
console.log(`SBOM recorded ${components.size} installed component versions.`);
