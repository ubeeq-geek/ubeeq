import {CommerceError} from './model.js';
/** Only first-party customer destinations; never proof links, external URLs or creator operations. */
export function customerReturnPath(value:unknown):string|undefined{
 if(value===undefined)return undefined;
 if(typeof value!=='string'||value.length>2000||!value.startsWith('/')||value.startsWith('//')||value.includes('\\'))throw new CommerceError('invalid_return_path');
 const url=new URL(value,'https://commerce.invalid');
 if(url.origin!=='https://commerce.invalid'||url.hash)throw new CommerceError('invalid_return_path');
 const store=url.pathname==='/commerce',buy=/^\/buy\/[A-Za-z0-9_-]+\/[a-z0-9-]+$/.test(url.pathname),purchases=url.pathname==='/commerce/purchases',checkout=/^\/commerce\/checkout\/[A-Za-z0-9_-]+$/.test(url.pathname);
 if(!store&&!buy&&!purchases&&!checkout)throw new CommerceError('invalid_return_path');
 const allowed=store?['owner','environment']:buy?['environment']:checkout?['cancelled']:purchases?['purchase','gift']:[];
 for(const [key,val] of url.searchParams){if(!allowed.includes(key)||url.searchParams.getAll(key).length!==1||key==='owner'&&!/^[A-Za-z0-9_-]+$/.test(val)||key==='environment'&&!['live','sandbox'].includes(val)||key==='cancelled'&&val!=='1'||(key==='purchase'||key==='gift')&&!/^[A-Za-z0-9_-]{1,200}$/.test(val))throw new CommerceError('invalid_return_path');}
 if(purchases&&url.searchParams.has('purchase')&&url.searchParams.has('gift'))throw new CommerceError('invalid_return_path');
 return url.pathname+url.search;
}
