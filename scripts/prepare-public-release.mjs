import {execFile} from 'node:child_process';
import {mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {publicPackageInventory} from './public-package-inventory.mjs';
const run=promisify(execFile),root=process.cwd(),output=resolve(process.argv[2]??'.release-artifacts');
const git=async args=>(await run('git',args,{cwd:root})).stdout.trim();
if(await git(['status','--porcelain','--untracked-files=normal']))throw Error('Release candidates require a clean committed source tree.');
const commit=await git(['rev-parse','HEAD']),tree=await git(['rev-parse','HEAD^{tree}']);
const packages=await publicPackageInventory(root),names=new Set(packages.map(p=>p.manifest.name));
const versions=new Set(packages.map(p=>p.manifest.version));if(versions.size!==1)throw Error('The coordinated initial release requires one reviewed public package version.');
for(const {manifest} of packages)for(const name of Object.keys({...manifest.dependencies,...manifest.optionalDependencies,...manifest.peerDependencies}))if(name.startsWith('@ubeeq/')&&!names.has(name))throw Error('A public dependency has no releasable workspace: '+name);
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw Error('Choose an empty release output directory.');const artifacts=[];
for(const {directory,manifest} of packages){
 const {stdout}=await run('npm',['pack','--ignore-scripts','--json','--pack-destination',output],{cwd:directory,maxBuffer:10_000_000});
 const [packed]=JSON.parse(stdout);if(basename(packed.filename)!==packed.filename)throw Error('Unsafe archive filename.');
 if(!packed.files.some(file=>/^LICENSE(?:\..*)?$/.test(file.path)))throw Error('Public archive has no license: '+manifest.name);
 const bytes=await readFile(join(output,packed.filename));
 artifacts.push({name:manifest.name,version:manifest.version,file:packed.filename,integrity:packed.integrity,sha256:createHash('sha256').update(bytes).digest('hex'),fileCount:packed.files.length});
}
await writeFile(join(output,'release-candidate.json'),JSON.stringify({schemaVersion:1,kind:'unpublished-candidate',source:{commit,tree},version:[...versions][0],packages:artifacts},null,2)+'\n');
console.log('Prepared '+artifacts.length+' unpublished package archives and their source/checksum manifest at '+output);
