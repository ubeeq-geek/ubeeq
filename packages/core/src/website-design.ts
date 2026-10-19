/** Portable design tokens and non-destructive page layouts shared by editor and renderer. */
export const WEBSITE_PAGE_TEMPLATES = [
  {id:'standard',title:'Reading',description:'A simple page with a comfortable reading width.'},
  {id:'cover',title:'Cover story',description:'A wide cover image above your title and content.'},
  {id:'profile',title:'About / profile',description:'A portrait beside your introduction.'},
  {id:'gallery',title:'Gallery',description:'A wide canvas for portfolios and gallery blocks.'}
] as const;
export type WebsitePageTemplate = typeof WEBSITE_PAGE_TEMPLATES[number]['id'];
export type WebsiteThemeId = 'neutral'|'ink'|'ocean'|'plum';
export interface WebsitePalette { canvas:string;text:string;muted:string;action:string;border:string; }
export const WEBSITE_THEMES: readonly {id:WebsiteThemeId;title:string;light:WebsitePalette;dark:WebsitePalette}[] = [
  {id:'neutral',title:'Evergreen',light:{canvas:'#fafaf9',text:'#202321',muted:'#525b55',action:'#225e47',border:'#a8b2aa'},dark:{canvas:'#181e1a',text:'#edf2ee',muted:'#b7c2b9',action:'#a3dfba',border:'#819687'}},
  {id:'ink',title:'Ink',light:{canvas:'#ffffff',text:'#202124',muted:'#555b65',action:'#344b74',border:'#abb4c0'},dark:{canvas:'#17191f',text:'#eff0f6',muted:'#bcc2d0',action:'#b6c9ff',border:'#707b92'}},
  {id:'ocean',title:'Ocean',light:{canvas:'#f2f8fc',text:'#122c3c',muted:'#415c70',action:'#075582',border:'#8aa7bb'},dark:{canvas:'#102531',text:'#edf7fc',muted:'#b0ccd9',action:'#86d2ff',border:'#7599ad'}},
  {id:'plum',title:'Plum',light:{canvas:'#fcf6fb',text:'#352138',muted:'#6b506d',action:'#7b326f',border:'#b9a0b5'},dark:{canvas:'#241927',text:'#f9edf6',muted:'#d2b8cf',action:'#f1b3dc',border:'#a78aa4'}}
];
