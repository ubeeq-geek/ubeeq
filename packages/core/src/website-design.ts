/** Portable design tokens and non-destructive page layouts shared by editor and renderer. */
export const WEBSITE_PAGE_TEMPLATES = [
  {id:'standard',title:'Reading',description:'A simple page with a comfortable reading width.'},
  {id:'cover',title:'Cover story',description:'A wide cover image above your title and content.'},
  {id:'profile',title:'About / profile',description:'A portrait beside your introduction.'},
  {id:'portfolio',title:'Portfolio hero',description:'An introduction beside a cover image, followed by editable gallery and offer sections.'},
  {id:'gallery',title:'Gallery',description:'A wide canvas for portfolios and gallery blocks.'}
] as const;
export type WebsitePageTemplate = typeof WEBSITE_PAGE_TEMPLATES[number]['id'];
export type WebsiteThemeId = 'neutral'|'ink'|'ocean'|'plum'|'modernist'|'nocturne'|'organic'|'cinema'|'literary'|'broadsheet';
export interface WebsitePalette { canvas:string;text:string;muted:string;action:string;border:string; }
export const WEBSITE_THEMES: readonly {id:WebsiteThemeId;title:string;light:WebsitePalette;dark:WebsitePalette}[] = [
  {id:'neutral',title:'Evergreen',light:{canvas:'#fafaf9',text:'#202321',muted:'#525b55',action:'#225e47',border:'#a8b2aa'},dark:{canvas:'#181e1a',text:'#edf2ee',muted:'#b7c2b9',action:'#a3dfba',border:'#819687'}},
  {id:'ink',title:'Ink',light:{canvas:'#ffffff',text:'#202124',muted:'#555b65',action:'#344b74',border:'#abb4c0'},dark:{canvas:'#17191f',text:'#eff0f6',muted:'#bcc2d0',action:'#b6c9ff',border:'#707b92'}},
  {id:'ocean',title:'Ocean',light:{canvas:'#f2f8fc',text:'#122c3c',muted:'#415c70',action:'#075582',border:'#8aa7bb'},dark:{canvas:'#102531',text:'#edf7fc',muted:'#b0ccd9',action:'#86d2ff',border:'#7599ad'}},
  {id:'modernist',title:'Modernist Portfolio',light:{canvas:'#f3f2ef',text:'#201e1d',muted:'#625d59',action:'#ae1800',border:'#aaa29b'},dark:{canvas:'#1b1918',text:'#f6f2ef',muted:'#c7bdb7',action:'#ff9e8c',border:'#8c7d73'}},
  {id:'broadsheet',title:'Broadsheet Audio',light:{canvas:'#f3f2f2',text:'#201e1d',muted:'#625b5c',action:'#00617e',border:'#a19a9c'},dark:{canvas:'#1b2024',text:'#f2f0ef',muted:'#c2bdbd',action:'#7ed7ed',border:'#8e9397'}},
  {id:'cinema',title:'Industry Films',light:{canvas:'#f2f2f3',text:'#1d1f20',muted:'#555b60',action:'#345878',border:'#9a9fa4'},dark:{canvas:'#171b20',text:'#eef1f4',muted:'#b4c0cb',action:'#a5c9ee',border:'#7d8b98'}},
  {id:'literary',title:'Classical Author',light:{canvas:'#f8f4eb',text:'#28251f',muted:'#665f52',action:'#705034',border:'#a69c8b'},dark:{canvas:'#24221d',text:'#f5eedf',muted:'#c5bba9',action:'#e7c096',border:'#938875'}},
 {id:'organic',title:'Organic Photography',light:{canvas:'#f5ead8',text:'#201e1d',muted:'#655644',action:'#853e1b',border:'#a1957f'},dark:{canvas:'#25211b',text:'#f5ead8',muted:'#c8bda8',action:'#f2b485',border:'#9a8c73'}},
 {id:'nocturne',title:'Nocturne Portfolio',light:{canvas:'#f5f5fa',text:'#1e2034',muted:'#57596d',action:'#5846a6',border:'#9a96ae'},dark:{canvas:'#11121c',text:'#f2f1fa',muted:'#bab8ce',action:'#c3b3ff',border:'#77728d'}},
  {id:'plum',title:'Plum',light:{canvas:'#fcf6fb',text:'#352138',muted:'#6b506d',action:'#7b326f',border:'#b9a0b5'},dark:{canvas:'#241927',text:'#f9edf6',muted:'#d2b8cf',action:'#f1b3dc',border:'#a78aa4'}}
];

/** Optional starter compositions; every section remains an ordinary editable block. */
export const WEBSITE_PRESETS = [
 {id:'broadsheet',title:'Broadsheet Audio',description:'Featured releases, listening links, discography, shows and merchandise links.'},
 {id:'standard',title:'Classic',description:'Simple reading pages and galleries.'},
 {id:'modernist',title:'Modernist Portfolio',description:'Bold typography, split hero, ruled galleries and membership callouts.'},
 {id:'cinema',title:'Industry Films',description:'Widescreen projects, trailers, credits and platform viewing links.'},
 {id:'literary',title:'Classical Author',description:'Book listings, long-form excerpts, readings and letters.'},
 {id:'organic',title:'Organic Photography',description:'Warm portrait galleries, session information and private client-gallery handoff.'},
 {id:'nocturne',title:'Nocturne Portfolio',description:'Atmospheric imagery, editorial galleries and a mailing-list offer.'}
] as const;
export function websitePresetBlocks(preset:string,page:string,createId:()=>import('./index.js').EntityId): import('./index.js').ContentBlock[] {
 const paragraph=(text:string)=>({id:createId(),type:'paragraph' as const,text});
 const action=(label:string,action:string)=>({id:createId(),type:'link' as const,label,data:{action,appearance:'primary'}});
 const section=(title:string,presentation:string,children:import('./index.js').ContentBlock[])=>({id:createId(),type:'section' as const,title,data:{presentation},children});
 if(page==='music')return [section('Featured release','release',[paragraph('Add cover artwork, release notes, credits and a track list here.'),action('Listen to the release','audio'),action('Buy the release','release')]),section('Discography','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}}])];
 if(page==='shows')return [section('Upcoming shows','standard',[paragraph('Add confirmed dates, venues, cities and ticket links here.')]),section('Hear about new dates','callout',[paragraph('Join the mailing list for release news and show announcements.'),action('Notify me','mailing')])];
 if(page==='merch')return [section('Merchandise','callout',[paragraph('Add your merchandise details, sizing information and store links here.'),action('Visit the merchandise store','merch')])];
 if(page==='home'&&preset==='broadsheet')return [section('','intro',[paragraph('New music, direct from the artist.'),action('Listen now','audio'),action('Buy the release','release')]),section('Featured release','release',[paragraph('Add cover artwork, release details, credits and your track list.')]),section('Discography','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}}]),section('Stay in the loop','callout',[paragraph('Hear about new releases and upcoming shows.'),action('Join the mailing list','mailing')])];
 if(page==='films')return [paragraph('Explore my films and recent projects.'),{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}},section('Featured film','screening',[paragraph('Add a poster, film synopsis, release year, running time and credits here.'),action('Watch trailer','trailer')])];
 if(page==='books')return [section('Books','bibliography',[paragraph('Add your book titles, publication details, cover images and links to read an excerpt or visit the publisher.')]),{id:createId(),type:'gallery_list',data:{sort:'oldest',pageSize:12}}];
 if(page==='readings')return [section('Readings and appearances','standard',[paragraph('Add confirmed dates, venues, cities, accessibility details and event links here.')])];
 if(page==='home'&&preset==='cinema')return [section('','intro',[paragraph('Independent films, stories and the people behind them.'),action('Watch the trailer','trailer'),action('Explore membership','membership')]),section('The films','screening',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}}]),section('How to watch','pricing',[section('Membership','plan',[paragraph('Describe viewing access and your membership terms.'),action('Explore membership','membership')]),section('Individual films','plan',[paragraph('Link each film to its available viewing, rental or purchase destination.')])])];
 if(page==='home'&&preset==='literary')return [section('From the writing desk','excerpt',[paragraph('Add an opening passage or a short excerpt from your latest work here.')]),section('Books','bibliography',[{id:createId(),type:'gallery_list',data:{sort:'oldest',pageSize:6}}]),section('Letters','callout',[paragraph('News from the writing desk: what I am reading, writing and where I will be.'),action('Subscribe to letters','mailing')])];
 if(page==='sessions')return [paragraph('Choose a session and request a time that works for you.'),section('Session options','pricing',[section('Portrait session','plan',[paragraph('Describe the session length, price, location and what is included.'),action('Check availability','booking')]),section('Family session','plan',[paragraph('Describe your family session and delivery timeline.'),action('Request a session','booking')])]),section('Studio and location','standard',[paragraph('Add your location, accessibility information and travel options.')])];
 if(page==='clients')return [paragraph('Your photographs are shared privately with you. Continue to the client gallery and use the email address your photographer invited.'),action('Open client galleries','clients')];
 if(page==='home'&&preset==='organic')return [section('','intro',[paragraph('Unhurried sessions, thoughtful photographs, and a gallery just for you.'),action('Check availability','booking')]),{id:createId(),type:'heading',level:2,text:'Recent work'},{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}},section('Make time for your people','callout',[paragraph('Explore sessions, choose a time, and tell me what you have in mind.'),action('Book a session','booking')])];
 if(page==='membership')return [paragraph('Choose how you would like to support my work.'),section('Membership options','pricing',[
 section('Membership','plan',[paragraph('Describe your membership benefits and billing terms here.'),action('Explore membership','membership')]),
 section('Individual galleries','plan',[paragraph('Describe your gallery access options here.'),action('Explore gallery access','membership')])]),section('Questions','faq',[section('How do I manage my membership?','faq_item',[paragraph('Continue to your platform account to review your membership and access options.'),action('Manage membership','account')])])];
 if(page!=='home')return [];
 return [section('','intro',[paragraph('Discover my latest work, explore the galleries, and follow what comes next.'),action('Explore membership','membership')]),{id:createId(),type:'heading',level:2,text:'Galleries'},{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}},section(preset==='nocturne'?'A little of my work, in your inbox':'Stay close to the work','callout',[paragraph(preset==='nocturne'?'Join my mailing list for updates and available offers.':'Explore membership and access more of my work.'),action(preset==='nocturne'?'Join the mailing list':'Explore membership',preset==='nocturne'?'mailing':'membership')])];
}
