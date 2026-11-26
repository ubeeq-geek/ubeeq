type JsonObject=Record<string,unknown>;
const record=(value:unknown):value is JsonObject=>!!value&&typeof value==='object'&&!Array.isArray(value);
export interface CustomerScopeEvent extends JsonObject {version:string;userPoolId:string;callerContext:{clientId:string};request:{userAttributes:Record<string,string>};response:JsonObject}
/** Actual V2/V3 access-token claim producer. Existing claims/scopes/groups are
 * preserved; conflicting ownership of this security claim fails explicitly. */
export function applyCustomerIssuedScope(original:CustomerScopeEvent,result:CustomerScopeEvent=original):CustomerScopeEvent{
 if(!record(original)||!record(original.request)||!record(original.request.userAttributes)||!record(original.response)||!record(result)||!record(result.response))throw Error('A genuine Cognito pre-token event is required.');
 const scope=original.request.userAttributes['custom:account_scope'];if(scope===undefined)return result;
 if(!['2','3'].includes(original.version)||!['customer_account','creator_operator'].includes(scope)||!original.request.userAttributes.sub||result.userPoolId!==original.userPoolId||result.callerContext?.clientId!==original.callerContext?.clientId||result.request?.userAttributes?.sub!==original.request.userAttributes.sub)throw Error('The Cognito issued-scope context conflicts.');
 const details=result.response.claimsAndScopeOverrideDetails;if(details!==undefined&&!record(details))throw Error('Existing token override details are unavailable.');
 const current=details??{},access=current.accessTokenGeneration;if(access!==undefined&&!record(access))throw Error('Existing access-token overrides are unavailable.');
 const generation=access??{},claims=generation.claimsToAddOrOverride,suppress=generation.claimsToSuppress;
 if(claims!==undefined&&!record(claims)||suppress!==undefined&&(!Array.isArray(suppress)||suppress.some(value=>typeof value!=='string')))throw Error('Existing access-token claims are unavailable.');
 if(record(claims)&&claims['custom:account_scope']!==undefined&&claims['custom:account_scope']!==scope||Array.isArray(suppress)&&suppress.includes('custom:account_scope'))throw Error('An existing trigger conflicts with canonical issued scope.');
 return {...result,response:{...result.response,claimsAndScopeOverrideDetails:{...current,accessTokenGeneration:{...generation,claimsToAddOrOverride:{...claims as JsonObject|undefined,'custom:account_scope':scope}}}}};
}
export function createCustomerIssuedScopeHandler(configuration:{userPoolId:string;clientIds:readonly string[]},delegate?:(event:CustomerScopeEvent)=>Promise<CustomerScopeEvent>){
 if(!configuration.userPoolId||!configuration.clientIds.length||configuration.clientIds.some(id=>typeof id!=='string'||!id)||new Set(configuration.clientIds).size!==configuration.clientIds.length)throw Error('Actual Cognito pool and client IDs are required.');
 return async(event:CustomerScopeEvent)=>{if(event.userPoolId!==configuration.userPoolId||!configuration.clientIds.includes(event.callerContext?.clientId))throw Error('Cognito trigger is outside the configured identity realm.');return applyCustomerIssuedScope(event,delegate?await delegate(structuredClone(event)):event);};
}
