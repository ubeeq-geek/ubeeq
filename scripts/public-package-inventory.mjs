import {readdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

export async function publicPackageInventory(root=process.cwd()){
 const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8')),packages=[];
 for(const pattern of manifest.workspaces){
  let directories=[root];
  for(const segment of pattern.split('/')){
   if(segment==='*')directories=(await Promise.all(directories.map(async directory=>(await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isDirectory()).map(entry=>join(directory,entry.name))))).flat();
   else{if(segment.includes('*')||segment==='..')throw Error('Unsupported workspace pattern: '+pattern);directories=directories.map(directory=>join(directory,segment));}
  }
  for(const directory of directories){
   let text;try{text=await readFile(join(directory,'package.json'),'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
   const manifest=JSON.parse(text);if(manifest.private===true)continue;
   if(!/^@ubeeq\/[a-z0-9-]+$/.test(manifest.name)||manifest.license!=='MIT')throw Error('Invalid public package scope or license: '+manifest.name);
   packages.push({directory:resolve(directory),manifest});
  }
 }
 if(new Set(packages.map(p=>p.manifest.name)).size!==packages.length)throw Error('Duplicate public package name.');
 return packages.sort((a,b)=>a.manifest.name.localeCompare(b.manifest.name));
}

export function validatePublishSelection(packages,workflow){
 const selected=new Set([...workflow.matchAll(/--workspace\s+(@ubeeq\/[a-z0-9-]+)/g)].map(match=>match[1]));
 const expected=new Set(packages.map(p=>p.manifest.name));
 for(const name of expected)if(!selected.has(name))throw Error('The publish workflow omits public package: '+name);
 for(const name of selected)if(!expected.has(name))throw Error('The publish workflow selects a private or unknown package: '+name);
 return expected.size;
}
