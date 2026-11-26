import {AdminGetUserCommand,ListUsersCommand,type AdminGetUserCommandOutput,type ListUsersCommandOutput} from '@aws-sdk/client-cognito-identity-provider';
import type {AwsCommandClient} from './client-port.js';
/** Canonical sub is retained across Native aliases and federation. Cognito
 * requires a provider Username for some third-party IdP accounts. Resolve that
 * name only through the real exact-sub inventory, then re-read the full user. */
export async function cognitoUserBySubject(client:AwsCommandClient,pool:string,subjectId:string):Promise<AdminGetUserCommandOutput|undefined>{
 const matches=(user:AdminGetUserCommandOutput|undefined)=>{if(!user||!Array.isArray(user.UserAttributes))return false;return user.UserAttributes.filter(item=>item?.Name==='sub').length===1&&user.UserAttributes.find(item=>item.Name==='sub')?.Value===subjectId;};
 try{const direct=await client.send(new AdminGetUserCommand({UserPoolId:pool,Username:subjectId}));if(matches(direct))return direct;}catch(error){if((error as {name?:string})?.name!=='UserNotFoundException')throw error;}
 let cursor:string|undefined;const cursors=new Set<string>(),names=new Set<string>();
 do{
  const page=await client.send(new ListUsersCommand({UserPoolId:pool,Filter:'sub = "'+subjectId.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"',Limit:60,...(cursor?{PaginationToken:cursor}:{})})) as ListUsersCommandOutput;
  if(!Array.isArray(page.Users))throw Error('Cognito canonical subject inventory is unavailable.');
  for(const user of page.Users){const attributes=user.Attributes;if(!Array.isArray(attributes)||attributes.filter(item=>item?.Name==='sub').length!==1||attributes.find(item=>item.Name==='sub')?.Value!==subjectId||typeof user.Username!=='string'||!user.Username)throw Error('Cognito subject lookup returned conflicting identities.');names.add(user.Username);}
  if(names.size>1)throw Error('Cognito canonical subject is ambiguous.');
  if(page.PaginationToken!==undefined&&(typeof page.PaginationToken!=='string'||!page.PaginationToken||cursors.has(page.PaginationToken)))throw Error('Cognito subject pagination is unavailable.');cursor=page.PaginationToken;if(cursor)cursors.add(cursor);
 }while(cursor);
 if(!names.size)return undefined;
 const user=await client.send(new AdminGetUserCommand({UserPoolId:pool,Username:[...names][0]}));if(!matches(user))throw Error('Cognito subject changed during provider re-read.');return user;
}
