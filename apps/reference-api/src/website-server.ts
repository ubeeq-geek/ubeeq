import { createServer } from 'node:http';
import { createNativeWebsiteHandler,NativeWebsiteHostingAdapter, type NativeWebsiteHostingProfile } from '@ubeeq/adapter-local';
// No application database, credential vault or editor session is opened by the static process.
const profile:NativeWebsiteHostingProfile={id:'local',root:process.env.UBEEQ_WEBSITE_HOSTING_ROOT??'',publicUrlTemplate:process.env.UBEEQ_WEBSITE_HOSTING_URL_TEMPLATE??'',persistent:true,writerMode:'single'};
new NativeWebsiteHostingAdapter(profile); // Validate administrator configuration without writing.
const serve=createNativeWebsiteHandler([profile]);
const server=createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'cache-control':'no-store'}).end('ok');return;}void serve(req,res);});
server.listen(Number(process.env.WEBSITE_PORT??4200),'0.0.0.0');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close());
