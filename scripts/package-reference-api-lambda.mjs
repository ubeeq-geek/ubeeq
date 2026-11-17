import {cpSync,existsSync,mkdirSync,readFileSync,readdirSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,relative,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),api=join(root,'apps/reference-api'),output=join(api,'lambda-package');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const copy=(source,target,options={})=>{mkdirSync(dirname(target),{recursive:true});cpSync(source,target,{recursive:true,...options});};
if(!existsSync(join(api,'dist/lambda.js')))throw Error('Build @ubeeq/reference-api before packaging its Lambda artifact.');
rmSync(output,{recursive:true,force:true});mkdirSync(output,{recursive:true});copy(join(api,'dist'),output);
copy(join(root,'apps/web-reference/src'),join(output,'web-reference'));
if(existsSync(join(root,'apps/web-reference/dist')))copy(join(root,'apps/web-reference/dist'),join(output,'dist'));
const workspaces=new Map();
for(const category of ['packages','adapters'])for(const entry of readdirSync(join(root,category),{withFileTypes:true})){
 const source=join(root,category,entry.name),path=join(source,'package.json');
 if(entry.isDirectory()&&existsSync(path)){const manifest=read(path);if(manifest.name?.startsWith('@ubeeq/'))workspaces.set(manifest.name,{source,manifest});}
}
const externalRoot=realpathSync(join(root,'node_modules')),installed=new Set(),inventory=[];
const within=(parent,path)=>{const value=relative(parent,path);return value===''||value!=='..'&&!value.startsWith('..'+sep)&&!value.startsWith(sep);};
function externalLocation(name,parent){
 const require=createRequire(join(parent,'package.json'));
 for(const lookup of require.resolve.paths(name)??[]){const candidate=join(lookup,name,'package.json');if(existsSync(candidate))return realpathSync(dirname(candidate));}
 return undefined;
}
function destinationFor(source){
 if(within(externalRoot,source))return join(output,'node_modules',relative(externalRoot,source));
 for(const {source:workspace,manifest} of workspaces.values()){
  const nested=join(workspace,'node_modules');if(within(nested,source))return join(output,'node_modules',manifest.name,'node_modules',relative(nested,source));
 }
 throw Error('A production dependency resolved outside this checkout: '+source);
}
function include(name,parent,optional=false){
 const workspace=workspaces.get(name),source=workspace?.source??externalLocation(name,parent);
 if(!source){if(optional)return;throw Error('Missing production Lambda dependency: '+name);}
 const canonical=realpathSync(source);if(installed.has(canonical))return;installed.add(canonical);
 const manifest=workspace?.manifest??read(join(source,'package.json')),target=workspace?join(output,'node_modules',name):destinationFor(canonical);
 if(workspace){
  copy(join(source,'package.json'),join(target,'package.json'));
  if(!existsSync(join(source,'dist')))throw Error('Build the Lambda workspace dependency: '+name);
  copy(join(source,'dist'),join(target,'dist'));
  if(existsSync(join(source,'LICENSE')))copy(join(source,'LICENSE'),join(target,'LICENSE'));
 }else{
  // Nested modules are copied through their declared graph, preserving their
  // installed locations without pulling development or ambient dependencies.
  copy(canonical,target,{dereference:true,filter:path=>path===canonical||basename(path)!=='node_modules'});
 }
 inventory.push({name:manifest.name,version:manifest.version,path:relative(output,target).split(sep).join('/')});
 for(const [dependency] of Object.entries({...manifest.dependencies,...manifest.optionalDependencies}))include(dependency,source,Object.hasOwn(manifest.optionalDependencies??{},dependency));
 for(const dependency of Object.keys(manifest.peerDependencies??{}))include(dependency,source,manifest.peerDependenciesMeta?.[dependency]?.optional===true);
}
const apiManifest=read(join(api,'package.json'));
for(const name of Object.keys(apiManifest.dependencies??{}))include(name,api);
writeFileSync(join(output,'package.json'),JSON.stringify({name:'@ubeeq/reference-api-lambda',version:apiManifest.version,private:true,dependencies:apiManifest.dependencies},null,2)+'\n');
writeFileSync(join(output,'runtime-dependencies.json'),JSON.stringify(inventory.sort((a,b)=>a.path.localeCompare(b.path)),null,2)+'\n');
console.log(`Packaged ${inventory.length} production dependencies at ${output}`);
