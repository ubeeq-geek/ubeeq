/** Portable design tokens and non-destructive page layouts shared by editor and renderer. */
export const WEBSITE_PAGE_TEMPLATES = [
  {id:'standard',title:'Reading',description:'A simple page with a comfortable reading width.'},
  {id:'cover',title:'Cover story',description:'A wide cover image above your title and content.'},
  {id:'profile',title:'About / profile',description:'A portrait beside your introduction.'},
  {id:'portfolio',title:'Portfolio hero',description:'An introduction beside a cover image, followed by editable gallery and offer sections.'},
  {id:'gallery',title:'Gallery',description:'A wide canvas for portfolios and gallery blocks.'}
] as const;
export type WebsitePageTemplate = typeof WEBSITE_PAGE_TEMPLATES[number]['id'];
export type WebsiteThemeId = 'neutral'|'ink'|'ocean'|'plum'|'modernist'|'nocturne'|'organic'|'cinema'|'literary'|'broadsheet'|'minimal'|'editorial'|'poster'|'peril-poise';
export interface WebsitePalette { canvas:string;text:string;muted:string;action:string;border:string; }
export const WEBSITE_THEMES: readonly {id:WebsiteThemeId;title:string;light:WebsitePalette;dark:WebsitePalette}[] = [
  {id:'neutral',title:'Evergreen',light:{canvas:'#fafaf9',text:'#202321',muted:'#525b55',action:'#225e47',border:'#a8b2aa'},dark:{canvas:'#181e1a',text:'#edf2ee',muted:'#b7c2b9',action:'#a3dfba',border:'#819687'}},
  {id:'peril-poise',title:'Peril & Poise',light:{canvas:'#f7f1e7',text:'#262123',muted:'#665550',action:'#79551e',border:'#947038'},dark:{canvas:'#151517',text:'#f3ebdf',muted:'#c9b9a8',action:'#d3ac64',border:'#b59559'}},
  {id:'ink',title:'Ink',light:{canvas:'#ffffff',text:'#202124',muted:'#555b65',action:'#344b74',border:'#abb4c0'},dark:{canvas:'#17191f',text:'#eff0f6',muted:'#bcc2d0',action:'#b6c9ff',border:'#707b92'}},
  {id:'ocean',title:'Ocean',light:{canvas:'#f2f8fc',text:'#122c3c',muted:'#415c70',action:'#075582',border:'#8aa7bb'},dark:{canvas:'#102531',text:'#edf7fc',muted:'#b0ccd9',action:'#86d2ff',border:'#7599ad'}},
  {id:'modernist',title:'Modernist',light:{canvas:'#f3f2ef',text:'#201e1d',muted:'#625d59',action:'#ae1800',border:'#aaa29b'},dark:{canvas:'#1b1918',text:'#f6f2ef',muted:'#c7bdb7',action:'#ff9e8c',border:'#8c7d73'}},
  {id:'minimal',title:'Minimal Gallery',light:{canvas:'#ffffff',text:'#171717',muted:'#5d5d5d',action:'#363636',border:'#aaaaaa'},dark:{canvas:'#161616',text:'#f6f6f6',muted:'#bdbdbd',action:'#eeeeee',border:'#898989'}},
  {id:'editorial',title:'Editorial Magazine',light:{canvas:'#f9f5ed',text:'#272420',muted:'#655d52',action:'#8c2c25',border:'#aaa193'},dark:{canvas:'#24211e',text:'#f7f0e4',muted:'#c6baaa',action:'#f1b2a0',border:'#988b79'}},
  {id:'poster',title:'Graphic Poster',light:{canvas:'#fff9ec',text:'#192340',muted:'#555b70',action:'#7c1459',border:'#9691a0'},dark:{canvas:'#182036',text:'#fff8eb',muted:'#bfc4d5',action:'#ffb2df',border:'#909ab5'}},
  {id:'broadsheet',title:'Broadsheet',light:{canvas:'#f3f2f2',text:'#201e1d',muted:'#625b5c',action:'#00617e',border:'#a19a9c'},dark:{canvas:'#1b2024',text:'#f2f0ef',muted:'#c2bdbd',action:'#7ed7ed',border:'#8e9397'}},
  {id:'cinema',title:'Industry',light:{canvas:'#f2f2f3',text:'#1d1f20',muted:'#555b60',action:'#345878',border:'#9a9fa4'},dark:{canvas:'#171b20',text:'#eef1f4',muted:'#b4c0cb',action:'#a5c9ee',border:'#7d8b98'}},
  {id:'literary',title:'Classical',light:{canvas:'#f8f4eb',text:'#28251f',muted:'#665f52',action:'#705034',border:'#a69c8b'},dark:{canvas:'#24221d',text:'#f5eedf',muted:'#c5bba9',action:'#e7c096',border:'#938875'}},
 {id:'organic',title:'Organic',light:{canvas:'#f5ead8',text:'#201e1d',muted:'#655644',action:'#853e1b',border:'#a1957f'},dark:{canvas:'#25211b',text:'#f5ead8',muted:'#c8bda8',action:'#f2b485',border:'#9a8c73'}},
 {id:'nocturne',title:'Nocturne',light:{canvas:'#f5f5fa',text:'#1e2034',muted:'#57596d',action:'#5846a6',border:'#9a96ae'},dark:{canvas:'#11121c',text:'#f2f1fa',muted:'#bab8ce',action:'#c3b3ff',border:'#77728d'}},
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
export function websiteIntentBlocks(intent:string,page:string,createId:()=>import('./index.js').EntityId): import('./index.js').ContentBlock[] {
 const paragraph=(text:string)=>({id:createId(),type:'paragraph' as const,text});
 const action=(label:string,action:string)=>({id:createId(),type:'link' as const,label,data:{action,appearance:'primary'}});
 const section=(title:string,presentation:string,children:import('./index.js').ContentBlock[])=>({id:createId(),type:'section' as const,title,data:{presentation},children});
 if(page==='services')return [section('Services and commissions','pricing',[section('Commission or service','plan',[paragraph('Describe the work you offer, scope, starting-price guidance and availability.'),action('Discuss a project','inquiry')])])];
 if(page==='process')return [section('How it works','standard',[paragraph('Describe inquiry, scope and quote, approval, creation, revisions and delivery.'),action('Start an inquiry','inquiry')])];
 if(page==='team')return [section('Meet the creators','creators',[paragraph('Introduce your contributors and add profile pages or links where appropriate.')])];
 if(page==='projects')return [section('Projects','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}}])];
 if(page==='events')return [section('Upcoming exhibitions and events','standard',[paragraph('Add confirmed event names, dates, venues, accessibility information and attendance details.'),action('Tickets and attendance','tickets')]),section('Past exhibitions','standard',[paragraph('Add past events, installation photographs and documentation.')])];
 if(page==='classes')return [section('Classes and workshops','pricing',[section('Workshop','plan',[paragraph('Add the topic, instructor, dates, level, materials, price and enrollment details.'),action('View enrollment options','course')])])];
 if(page==='resources')return [section('Learning resources','standard',[paragraph('Add approved public reading, video, audio and downloadable resource links.')])];
 if(page==='catalogue')return [section('Catalogue','standard',[{id:createId(),type:'gallery_list',data:{sort:'oldest',pageSize:12}}])];
 if(page==='chronology')return [section('Chronology and provenance','standard',[paragraph('Document dates, collections, editions, credits and provenance using verified information.')])];
 if(page==='shop')return [section('Browse the catalogue','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}}]),section('Visit the store','callout',[paragraph('Product options, checkout and fulfillment are handled at the configured store destination.'),action('Open the store','store')])];
 if(page==='shipping')return [section('Shipping and delivery','standard',[paragraph('Add your actual delivery, shipping, returns and customer-support information. Link to the current policies at your store.'),action('Store and delivery information','store')])];
 if(page==='home'&&intent==='commissions')return [section('','intro',[paragraph('Creative work made with you. Explore my services and discuss your next project.'),action('Start a project inquiry','inquiry')]),section('Selected work','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}}])];
 if(page==='home'&&intent==='collective')return [section('','intro',[paragraph('Independent creators, shared projects and a collective body of work.')]),section('Featured projects','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}}]),section('The creators','creators',[])];
 if(page==='home'&&intent==='events')return [section('','intro',[paragraph('Exhibitions, events and encounters with the work.'),action('Tickets and attendance','tickets')]),section('Current and upcoming','standard',[paragraph('Add your confirmed event dates, locations and details.')]),section('From the archive','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}}])];
 if(page==='home'&&intent==='education')return [section('','intro',[paragraph('Learn through practice. Explore classes, workshops and resources.'),action('Explore enrollment','course')]),section('Classes and workshops','pricing',[section('Featured workshop','plan',[paragraph('Describe a real workshop, its schedule and what learners can expect.'),action('Workshop details','course')])]),section('Resources','standard',[paragraph('Add public learning resources and instructor information.')])];
 if(page==='home'&&intent==='archive')return [section('','intro',[paragraph('An evolving catalogue of work, collections and their histories.')]),section('Explore the catalogue','standard',[{id:createId(),type:'gallery_list',data:{sort:'oldest',pageSize:12}}])];
 if(page==='home'&&intent==='shop')return [section('','intro',[paragraph('Explore available work and product information.'),action('Visit the store','store')]),section('The catalogue','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}}])];
 if(page==='episodes')return [section('Episodes','episodes',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}}])];
 if(page==='listen')return [section('Listen and subscribe','standard',[paragraph('Choose your preferred listening destination.'),action('Listen to the show','audio'),action('Public podcast feed','podcast_feed'),action('Explore membership','membership')])];
 if(page==='advertise')return [section('Sponsorship and advertising','standard',[paragraph('Describe your sponsorship options, audience and contact process using verified figures.'),action('Request sponsorship information','sponsorship')])];
 if(page==='home'&&intent==='podcast')return [section('','intro',[paragraph('Conversations, stories and ideas worth listening to.'),action('Play the latest episode','audio'),action('Subscribe to the public feed','podcast_feed')]),section('Latest episode','episode',[paragraph('Add the episode title, guest, release date, running time and listening link.')]),section('Recent episodes','episodes',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}}]),section('Ways to listen','pricing',[section('Listen to the show','plan',[action('Listen now','audio'),action('Public feed','podcast_feed')]),section('Membership','plan',[paragraph('Describe your actual membership benefits and link to platform-managed access.'),action('Explore membership','membership')])])];
 if(page==='music')return [section('Featured release','release',[paragraph('Add cover artwork, release notes, credits and a track list here.'),action('Listen to the release','audio'),action('Buy the release','release')]),section('Discography','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}}])];
 if(page==='shows')return [section('Upcoming shows','standard',[paragraph('Add confirmed dates, venues, cities and ticket links here.')]),section('Hear about new dates','callout',[paragraph('Join the mailing list for release news and show announcements.'),action('Notify me','mailing')])];
 if(page==='merch')return [section('Merchandise','callout',[paragraph('Add your merchandise details, sizing information and store links here.'),action('Visit the merchandise store','merch')])];
 if(page==='home'&&intent==='music')return [section('','intro',[paragraph('New music, direct from the artist.'),action('Listen now','audio'),action('Buy the release','release')]),section('Featured release','release',[paragraph('Add cover artwork, release details, credits and your track list.')]),section('Discography','standard',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}}]),section('Stay in the loop','callout',[paragraph('Hear about new releases and upcoming shows.'),action('Join the mailing list','mailing')])];
 if(page==='films')return [paragraph('Explore my films and recent projects.'),{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}},section('Featured film','screening',[paragraph('Add a poster, film synopsis, release year, running time and credits here.'),action('Watch trailer','trailer')])];
 if(page==='books')return [section('Books','bibliography',[paragraph('Add your book titles, publication details, cover images and links to read an excerpt or visit the publisher.')]),{id:createId(),type:'gallery_list',data:{sort:'oldest',pageSize:12}}];
 if(page==='readings')return [section('Readings and appearances','standard',[paragraph('Add confirmed dates, venues, cities, accessibility details and event links here.')])];
 if(page==='home'&&intent==='film')return [section('','intro',[paragraph('Independent films, stories and the people behind them.'),action('Watch the trailer','trailer'),action('Explore membership','membership')]),section('The films','screening',[{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}}]),section('How to watch','pricing',[section('Membership','plan',[paragraph('Describe viewing access and your membership terms.'),action('Explore membership','membership')]),section('Individual films','plan',[paragraph('Link each film to its available viewing, rental or purchase destination.')])])];
 if(page==='home'&&intent==='literature')return [section('From the writing desk','excerpt',[paragraph('Add an opening passage or a short excerpt from your latest work here.')]),section('Books','bibliography',[{id:createId(),type:'gallery_list',data:{sort:'oldest',pageSize:6}}]),section('Letters','callout',[paragraph('News from the writing desk: what I am reading, writing and where I will be.'),action('Subscribe to letters','mailing')])];
 if(page==='sessions')return [paragraph('Choose a session and request a time that works for you.'),section('Session options','pricing',[section('Portrait session','plan',[paragraph('Describe the session length, price, location and what is included.'),action('Check availability','booking')]),section('Family session','plan',[paragraph('Describe your family session and delivery timeline.'),action('Request a session','booking')])]),section('Studio and location','standard',[paragraph('Add your location, accessibility information and travel options.')])];
 if(page==='clients')return [paragraph('Your photographs are shared privately with you. Continue to the client gallery and use the email address your photographer invited.'),action('Open client galleries','clients')];
 if(page==='home'&&intent==='photography')return [section('','intro',[paragraph('Unhurried sessions, thoughtful photographs, and a gallery just for you.'),action('Check availability','booking')]),{id:createId(),type:'heading',level:2,text:'Recent work'},{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:6}},section('Make time for your people','callout',[paragraph('Explore sessions, choose a time, and tell me what you have in mind.'),action('Book a session','booking')])];
 if(page==='membership')return [paragraph('Choose how you would like to support my work.'),section('Membership options','pricing',[
 section('Membership','plan',[paragraph('Describe your membership benefits and billing terms here.'),action('Explore membership','membership')]),
 section('Individual galleries','plan',[paragraph('Describe your gallery access options here.'),action('Explore gallery access','membership')])]),section('Questions','faq',[section('How do I manage my membership?','faq_item',[paragraph('Continue to your platform account to review your membership and access options.'),action('Manage membership','account')])])];
 if(page!=='home')return [];
 return [section('','intro',[paragraph('Discover my latest work, explore the galleries, and follow what comes next.'),action('Explore membership','membership')]),{id:createId(),type:'heading',level:2,text:'Galleries'},{id:createId(),type:'gallery_list',data:{sort:'newest',pageSize:12}},section('Stay close to the work','callout',[paragraph('Join my mailing list for updates and available offers.'),action('Join the mailing list','mailing')])];
}

/** Purpose determines suggested composition; visual styles remain entirely independent. */
export const WEBSITE_INTENTS = [
 {id:'portfolio',title:'Visual portfolio',description:'Showcase work, galleries, introductions and audience updates.',pages:['galleries','about','contact']},
 {id:'photography',title:'Session photography',description:'Session information, booking requests and private client-gallery links.',pages:['galleries','sessions','clients','about','contact']},
 {id:'film',title:'Film and video',description:'Films, trailers, project notes and viewing destinations.',pages:['films','membership','about','contact']},
 {id:'literature',title:'Author and literature',description:'Books, excerpts, shorter work, readings and letters.',pages:['books','readings','about','contact']},
 {id:'music',title:'Musical artist',description:'Releases, discography, shows and merchandise destinations.',pages:['music','shows','merch','about','contact']},
 {id:'podcast',title:'Podcast',description:'Episodes, show notes, listening and feed links, membership and sponsorship.',pages:['episodes','listen','membership','about','advertise','contact']},
 {id:'commissions',title:'Commissions and services',description:'Services, scope, process, availability guidance and inquiry links.',pages:['services','process','galleries','about','contact']},
 {id:'collective',title:'Collective or studio',description:'Multiple creator identities, shared projects, team profiles and contact.',pages:['projects','team','about','contact']},
 {id:'events',title:'Exhibitions and events',description:'Upcoming exhibitions, venues, attendance links and event archives.',pages:['events','galleries','about','contact']},
 {id:'education',title:'Teaching and workshops',description:'Classes, instructor information, resources and enrollment destinations.',pages:['classes','resources','about','contact']},
 {id:'archive',title:'Archive or catalogue',description:'Collections, chronology, detailed credits and provenance.',pages:['catalogue','chronology','about','contact']},
 {id:'shop',title:'Shop and product catalogue',description:'Product listings and configured store links; checkout and fulfillment stay at the destination.',pages:['shop','shipping','about','contact']}
] as const;
export type WebsiteIntentId=typeof WEBSITE_INTENTS[number]['id'];
export const legacyWebsiteIntent=(preset:string):WebsiteIntentId=>({organic:'photography',cinema:'film',literary:'literature',broadsheet:'music'}[preset]??'portfolio') as WebsiteIntentId;
/** Compatibility for callers that used the original combined starter presets. */
export function websitePresetBlocks(preset:string,page:string,createId:()=>import('./index.js').EntityId):import('./index.js').ContentBlock[]{return websiteIntentBlocks(legacyWebsiteIntent(preset),page,createId);}
