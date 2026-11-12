import {WebsiteError,type WebsiteDependency} from '@ubeeq/core';
import {createHash} from 'node:crypto';
import {repositoryItems,type UbeeqRepositories,type AssetRecord,type WorkRecord,type PublicationRecord} from '@ubeeq/persistence';

/** A projection is reusable only while the authoritative database revision is unchanged.
 * No TTL or process-local event delivery is used to cache publication eligibility. */
export function createWebsiteSourceReader(repositories:UbeeqRepositories,revision?:()=>string){
  const cached=new Map<string,{revision:string;value:Promise<WebsiteSources>}>();
  const all=async<T>(repository:{list(request:{limit:number;cursor?:string}):Promise<{items:readonly T[];nextCursor?:string}>})=>{
    const values:T[]=[];for await(const value of repositoryItems(request=>repository.list(request)))values.push(value);return values;
  };
  const load=async(workspaceId:string):Promise<WebsiteSources>=>{
    const [workRows,assetRows,publicationRows,holds]=await Promise.all([all(repositories.works),all(repositories.assets),all(repositories.publications),all(repositories.moderationHolds)]);
    const works=new Map(workRows.filter(work=>work.creatorId===workspaceId).map(work=>[work.id,work]));
    const assets=new Map(assetRows.filter(asset=>asset.creatorId===workspaceId).map(asset=>[asset.id,asset]));
    const publications=new Map(publicationRows.filter(publication=>works.has(publication.workId)).map(publication=>[publication.id,publication]));
    const assetsByWork=new Map<string,AssetRecord[]>(),publicationsByWork=new Map<string,PublicationRecord[]>();
    for(const asset of assets.values())if(asset.workId&&asset.status==='ready'){const rows=assetsByWork.get(asset.workId)??[];rows.push(asset);assetsByWork.set(asset.workId,rows);}
    for(const publication of publications.values())if(publication.status==='live'){const rows=publicationsByWork.get(publication.workId)??[];rows.push(publication);publicationsByWork.set(publication.workId,rows);}
    const held=new Set(holds.filter(hold=>hold.state==='active').map(hold=>hold.subjectId));
    const publicWorks=new Map<string,{work:WorkRecord;assets:AssetRecord[];publications:PublicationRecord[]}>();
    const current=(id:string)=>{
      const previous=publicWorks.get(id);if(previous)return previous;
      const work=works.get(id),media=assetsByWork.get(id)??[],live=publicationsByWork.get(id)??[];
      if(!work||work.status!=='published'||!media.length||!live.length||[workspaceId,id,...media.map(asset=>asset.id)].some(subject=>held.has(subject)))throw new WebsiteError('media_not_public','A website source is no longer publicly available.');
      const result={work,assets:media,publications:live};publicWorks.set(id,result);return result;
    };
    const revisions=new Map<string,string>();
    const sourceRevision=(id:string)=>{
      let value=revisions.get(id);if(value)return value;
      const source=current(id);value=String(source.work.revision)+':'+createHash('sha256').update(JSON.stringify([
        source.assets.map(asset=>[asset.id,asset.revision,asset.checksum]).sort(([a],[b])=>String(a).localeCompare(String(b))),
        source.publications.map(publication=>[publication.id,publication.revision]).sort(([a],[b])=>String(a).localeCompare(String(b)))
      ])).digest('hex');revisions.set(id,value);return value;
    };
    const eligible=(dependencies:readonly WebsiteDependency[],exact=false)=>{
      if(held.has(workspaceId)||dependencies.some(dependency=>held.has(dependency.id)))return false;
      const checked=new Set<string>();
      try{for(const dependency of dependencies){
        let workId:string|undefined;
        if(dependency.kind==='asset'){const asset=assets.get(dependency.id);if(!asset?.workId||asset.status!=='ready'||!dependency.revision.startsWith(asset.revision+':'))return false;workId=asset.workId;}
        if(dependency.kind==='publication'){const publication=publications.get(dependency.id);if(!publication||publication.status!=='live'||publication.destination!=='local'||exact&&String(publication.revision)!==dependency.revision)return false;workId=publication.workId;}
        if(dependency.kind==='catalogue'){const work=works.get(dependency.id);if(!work||exact&&sourceRevision(work.id)!==dependency.revision)return false;workId=work.id;}
        if(workId&&!checked.has(workId)){const work=current(workId);if(!work.publications.some(publication=>publication.destination==='local'))return false;checked.add(workId);}
      }}catch{return false;}return true;
    };
    return {works,assets,publications,current,eligible,revision:sourceRevision};
  };
  return (workspaceId:string):Promise<WebsiteSources>=>{
    if(!revision)return load(workspaceId);
    const version=revision(),previous=cached.get(workspaceId);if(previous?.revision===version)return previous.value;
    const value=load(workspaceId);cached.set(workspaceId,{revision:version,value});
    if(cached.size>8)cached.delete(cached.keys().next().value!);
    void value.then(()=>{if(revision()!==version&&cached.get(workspaceId)?.value===value)cached.delete(workspaceId);},()=>{if(cached.get(workspaceId)?.value===value)cached.delete(workspaceId);});
    return value;
  };
}
export interface WebsiteSources {
  works:ReadonlyMap<string,WorkRecord>;assets:ReadonlyMap<string,AssetRecord>;publications:ReadonlyMap<string,PublicationRecord>;
  current(id:string):{work:WorkRecord;assets:readonly AssetRecord[];publications:readonly PublicationRecord[]};
  eligible(dependencies:readonly WebsiteDependency[],exact?:boolean):boolean;
  revision(id:string):string;
}

/** All in-flight work settles before errors escape; results retain source order. */
export async function mapWebsiteSources<T,R>(items:readonly T[],operation:(item:T)=>Promise<R>,concurrency=2):Promise<R[]>{
  const results:R[]=new Array(items.length);let next=0,failure:unknown,failed=false;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(next<items.length&&!failed){const index=next++;try{results[index]=await operation(items[index]);}catch(error){failure=error;failed=true;}}}));
  if(failed)throw failure;return results;
}
