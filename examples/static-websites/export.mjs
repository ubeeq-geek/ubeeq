import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildWebsiteArtifact, websiteDigest } from '@ubeeq/portability';
import { createCropSourcePreview } from '@ubeeq/media-sharp';

// Public demonstration data only. Applications use WebsiteService and its current
// membership, source eligibility and release-policy ports instead of calling this
// low-level artifact builder directly from an HTTP request.
const workspaceId='demo-workspace',websiteId='demo-site';
const p=(id,slug,extra={})=>({id,websiteId,workspaceId,revision:1,documentId:'document-'+id,title:id==='home'?'Home':id==='about'?'About':'Field notes',slug,kind:'page',order:1,state:'ready',navigation:true,...extra});
const pages=[p('home','',{kind:'home',order:0}),p('about','about'),p('notes','notes',{parentId:'about'})];
const website={id:websiteId,workspaceId,creatorIdentityId:'demo-creator',revision:1,title:'An independent portfolio',locale:'en',homePageId:'home',theme:{id:'neutral',version:'1',settings:{colorMode:'light',width:'reading',footer:'Public demonstration website'}},mediaMode:'bundled',basePath:'/',galleryDefault:{destination:{mode:'local'}},pages,galleryPublicationIds:['demo-publication'],redirects:[{from:'/biography/',to:'/about/',status:301}]};
const source=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNQinMHAAFtAMjJGretAAAAAElFTkSuQmCC','base64');
const rendition=await createCropSourcePreview(source);
const asset={id:'demo-public-rendition',workspaceId,revision:1,checksum:websiteDigest(rendition.body),mimeType:'image/jpeg',bytes:rendition.body,alt:'A small demonstration image',width:rendition.width,height:rendition.height,approvedPublic:true,metadataStripped:true};
const block=(type,fields={})=>({id:'demo-'+type,type,...fields});
const snapshot={apiVersion:'1',website,documents:pages.map(page=>({id:page.documentId,workspaceId,revision:1,blocks:page.id==='home'?[
  block('paragraph',{text:'This website is ordinary HTML, CSS and bundled public media. It remains readable with Ubeeq offline.'}),
  block('gallery_preview',{data:{publicationIds:['demo-publication']}}),
  block('page_link',{label:'Read the field notes',data:{pageId:'notes'}})
]:[block('paragraph',{text:page.id==='about'?'A quiet place for independent work.':'Field notes are edited through the same structured content editor.'})]})),galleries:[{publicationId:'demo-publication',workId:'demo-work',workspaceId,revision:1,title:'Public selection',slug:'public-selection',tags:[],collectionIds:[],date:'2026-10-18',premium:false,previewAssetIds:[asset.id],publicAssetIds:[asset.id]}],mappings:[],assets:[asset],dependencies:[]};
const artifact=buildWebsiteArtifact(snapshot,{maxPages:100,maxAssets:100,maxBytes:10*1024*1024});
const output=await mkdtemp(join(tmpdir(),'ubeeq-static-website-'));
for(const [path,bytes] of artifact.files){await mkdir(dirname(join(output,'site',path)),{recursive:true});await writeFile(join(output,'site',path),bytes);}
await writeFile(join(output,'website.zip'),artifact.zip);
await writeFile(join(output,'private-report.json'),JSON.stringify({digest:artifact.digest,snapshotDigest:artifact.snapshotDigest,report:artifact.report,warnings:artifact.warnings,dependencies:artifact.dependencies},null,2)+'\n');
console.log(JSON.stringify({directory:join(output,'site'),zip:join(output,'website.zip'),report:join(output,'private-report.json'),digest:artifact.digest,...artifact.report},null,2));
