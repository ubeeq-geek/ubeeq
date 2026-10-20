/** Portable design tokens and non-destructive page layouts shared by editor and renderer. */
export const WEBSITE_PAGE_TEMPLATES = [
  {id:'standard',title:'Reading',description:'A simple page with a comfortable reading width.'},
  {id:'cover',title:'Cover story',description:'A wide cover image above your title and content.'},
  {id:'profile',title:'About / profile',description:'A portrait beside your introduction.'},
  {id:'portfolio',title:'Portfolio hero',description:'An introduction beside a cover image, followed by editable gallery and offer sections.'},
  {id:'gallery',title:'Gallery',description:'A wide canvas for portfolios and gallery blocks.'}
] as const;
export type WebsitePageTemplate = typeof WEBSITE_PAGE_TEMPLATES[number]['id'];
export type WebsiteThemeId = 'neutral'|'ink'|'ocean'|'plum'|'modernist'|'nocturne';
export interface WebsitePalette { canvas:string;text:string;muted:string;action:string;border:string; }
export const WEBSITE_THEMES: readonly {id:WebsiteThemeId;title:string;light:WebsitePalette;dark:WebsitePalette}[] = [
  {id:'neutral',title:'Evergreen',light:{canvas:'#fafaf9',text:'#202321',muted:'#525b55',action:'#225e47',border:'#a8b2aa'},dark:{canvas:'#181e1a',text:'#edf2ee',muted:'#b7c2b9',action:'#a3dfba',border:'#819687'}},
  {id:'ink',title:'Ink',light:{canvas:'#ffffff',text:'#202124',muted:'#555b65',action:'#344b74',border:'#abb4c0'},dark:{canvas:'#17191f',text:'#eff0f6',muted:'#bcc2d0',action:'#b6c9ff',border:'#707b92'}},
  {id:'ocean',title:'Ocean',light:{canvas:'#f2f8fc',text:'#122c3c',muted:'#415c70',action:'#075582',border:'#8aa7bb'},dark:{canvas:'#102531',text:'#edf7fc',muted:'#b0ccd9',action:'#86d2ff',border:'#7599ad'}},
  {id:'modernist',title:'Modernist Portfolio',light:{canvas:'#f3f2ef',text:'#201e1d',muted:'#625d59',action:'#ae1800',border:'#aaa29b'},dark:{canvas:'#1b1918',text:'#f6f2ef',muted:'#c7bdb7',action:'#ff9e8c',border:'#8c7d73'}},
  {id:'nocturne',title:'Nocturne Portfolio',light:{canvas:'#f5f5fa',text:'#1e2034',muted:'#57596d',action:'#5846a6',border:'#9a96ae'},dark:{canvas:'#11121c',text:'#f2f1fa',muted:'#bab8ce',action:'#c3b3ff',border:'#77728d'}},
  {id:'plum',title:'Plum',light:{canvas:'#fcf6fb',text:'#352138',muted:'#6b506d',action:'#7b326f',border:'#b9a0b5'},dark:{canvas:'#241927',text:'#f9edf6',muted:'#d2b8cf',action:'#f1b3dc',border:'#a78aa4'}}
];

/** Optional starter compositions; every section remains an ordinary editable block. */
export const WEBSITE_PRESETS = [
 {id:'standard',title:'Classic',description:'Simple reading pages and galleries.'},
 {id:'modernist',title:'Modernist Portfolio',description:'Bold typography, split hero, ruled galleries and membership callouts.'},
 {id:'nocturne',title:'Nocturne Portfolio',description:'Atmospheric imagery, editorial galleries and a mailing-list offer.'}
] as const;
export function websitePresetBlocks(preset:string,page:string,createId:()=>import('./index.js').EntityId): import('./index.js').ContentBlock[] {
 const paragraph=(text:string)=>({id:createId(),type:'paragraph' as const,text});
 const action=(label:string,action:string)=>({id:createId(),type:'link' as const,label,data:{action,appearance:'primary'}});
 const section=(title:string,presentation:string,children:import('./index.js').ContentBlock[])=>({id:createId(),type:'section' as const,title,data:{presentation},children});
 if(page==='membership')return [paragraph('Choose how you would like to support my work.'),section('Membership options','pricing',[
 section('Membership','plan',[paragraph('Describe your membership benefits and billing terms here.'),action('Explore membership','membership')]),
 section('Individual galleries','plan',[paragraph('Describe your gallery access options here.'),action('Explore gallery access','membership')])]),section('Questions','faq',[section('How do I manage my membership?','faq_item',[paragraph('Continue to your platform account to review your membership and access options.'),action('Manage membership','account')])])];
 if(page!=='home')return [];
 return [section('','intro',[paragraph('Discover my latest work, explore the galleries, and follow what comes next.'),action('Explore membership','membership')]),{id:createId(),type:'heading',level:2,text:'Galleries'},{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}},section(preset==='nocturne'?'A little of my work, in your inbox':'Stay close to the work','callout',[paragraph(preset==='nocturne'?'Join my mailing list for updates and available offers.':'Explore membership and access more of my work.'),action(preset==='nocturne'?'Join the mailing list':'Explore membership',preset==='nocturne'?'mailing':'membership')])];
}
