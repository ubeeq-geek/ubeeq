import {randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import {CustomerIdentityError,type CustomerIdentity,type CustomerIdentityProvider,type CustomerPasswordAcceptance,type CustomerPasswordEffect,type CustomerPasswordSessionProof} from '@ubeeq/auth';
import type {LocalSqliteDatabase} from './index.js';
type Row={id:string;email:string;password_hash:string;salt:string;status:string;created_at:string;updated_at:string;account_scope:string;roles_json:string;scopes_json:string;email_verified:number;customer_password_state:'unset'|'set'};
const derive=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,(error,key)=>error?reject(error):resolve(key)));
const invalid=()=>new CustomerIdentityError('unavailable','Current customer identity evidence is unavailable.');
const email=(value:string)=>{if(typeof value!=='string'||value.length>254)throw invalid();const normalized=value.trim().toLowerCase();if(!/^\S+@\S+\.\S+$/.test(normalized))throw invalid();return normalized;};
const sameCredential=(before:Row,after:Row)=>['id','email','password_hash','salt','status','account_scope','roles_json','scopes_json','email_verified','customer_password_state'].every(key=>before[key as keyof Row]===after[key as keyof Row]);
const password=(value:string)=>{if(typeof value!=='string'||value.length<12||value.length>128)throw new CustomerIdentityError('invalid_password','Password requirements were not met.');};
export class LocalCustomerIdentities implements CustomerIdentityProvider {
 readonly provider='local' as const;
 constructor(private readonly local:LocalSqliteDatabase){}
 async verifyConfiguration():Promise<void>{const fields=this.local.database.prepare('PRAGMA table_info(ubeeq_accounts)').all() as Array<{name:string}>,sessions=this.local.database.prepare('PRAGMA table_info(ubeeq_sessions)').all() as Array<{name:string}>;if(!['account_scope','roles_json','scopes_json','email_verified','customer_password_state'].every(name=>fields.some(field=>field.name===name))||!sessions.some(field=>field.name==='account_scope_at_issue'))throw invalid();}
 private row(id:string,byEmail=false):Row|undefined{return this.local.database.prepare('SELECT * FROM ubeeq_accounts WHERE '+(byEmail?'email':'id')+'=?').get(id) as Row|undefined;}
 private value(row:Row):CustomerIdentity {
  if(!['creator_operator','customer_account'].includes(row.account_scope)||![0,1].includes(row.email_verified)||!['set','unset'].includes(row.customer_password_state)||!['active','pending_verification','suspended','closed'].includes(row.status))throw invalid();
  const roles:unknown=JSON.parse(row.roles_json),scopes:unknown=JSON.parse(row.scopes_json);if(!Array.isArray(roles)||roles.some(role=>typeof role!=='string')||!Array.isArray(scopes)||scopes.some(scope=>typeof scope!=='string'))throw invalid();
  return {userId:row.id,email:row.email,emailVerified:row.email_verified===1,accountScope:row.account_scope as CustomerIdentity['accountScope'],provider:'local',providerUsername:row.email,
   account:{id:row.id,subjectId:row.id,status:row.status as CustomerIdentity['account']['status'],createdAt:row.created_at,updatedAt:row.updated_at},passwordSetupRequired:row.customer_password_state==='unset',standardSignInRequired:row.account_scope!=='customer_account'||roles.some(role=>['Admins','admin','Creators','creator','Contributors','contributor','Artists'].includes(role))};
 }
 private customer(row:Row|undefined):Row {
  if(!row||row.status!=='active'||row.account_scope!=='customer_account'||row.email_verified!==1||this.value(row).standardSignInRequired)throw new CustomerIdentityError('standard_sign_in_required','Use the account’s existing sign-in method.');return row;
 }
 async findByEmail(address:string){const row=this.row(email(address),true);return row?this.value(row):undefined;}
 async current(userId:string){const row=this.row(userId);return row?this.value(row):undefined;}
 async provisionVerifiedEmail(address:string):Promise<CustomerIdentity>{
  await this.verifyConfiguration();const normalized=email(address),existing=this.row(normalized,true);if(existing)return this.value(existing);
  const salt=randomBytes(24).toString('hex'),unusable=await derive(randomBytes(48).toString('base64url'),salt),id=randomUUID(),now=new Date().toISOString();
  this.local.transactionSync(()=>{
   if(this.row(normalized,true))return;
   this.local.database.prepare("INSERT INTO ubeeq_accounts(id,email,password_hash,salt,status,created_at,updated_at,account_scope,roles_json,scopes_json,email_verified,customer_password_state) VALUES(?,?,?,?,?,?,?,?,?,?,1,'unset')").run(id,normalized,unusable.toString('hex'),salt,'active',now,now,'customer_account','["customer_account"]','["commerce.customer"]');
  });return this.value(this.row(normalized,true)!);
 }
 private operation(acceptance?:CustomerPasswordAcceptance){const id=acceptance?.operationId??randomUUID();if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))throw invalid();return id;}
 async readPasswordMutation(userId:string,operationId:string):Promise<CustomerPasswordEffect|undefined>{
  return this.local.transaction(async()=>{const row=this.local.database.prepare('SELECT payload FROM ubeeq_customer_password_effects WHERE id=? AND user_id=?').get(operationId,userId) as {payload:string}|undefined;if(!row)return undefined;const value=JSON.parse(row.payload) as CustomerPasswordEffect;if(value.schemaVersion!==1||value.operationId!==operationId||value.userId!==userId||value.provider!=='local'||!['initial','change'].includes(value.kind)||!Number.isFinite(Date.parse(value.appliedAt)))throw invalid();return value;});
 }
 private effect(id:string,userId:string,kind:'initial'|'change'):CustomerPasswordEffect{const effect:CustomerPasswordEffect={schemaVersion:1,operationId:id,userId,kind,provider:'local',appliedAt:new Date().toISOString()};this.local.database.prepare('INSERT INTO ubeeq_customer_password_effects(id,user_id,kind,applied_at,payload) VALUES(?,?,?,?,?)').run(id,userId,kind,effect.appliedAt,JSON.stringify(effect));return effect;}
 async setInitialPassword(userId:string,next:string,acceptance?:CustomerPasswordAcceptance):Promise<CustomerPasswordEffect>{
  await this.verifyConfiguration();password(next);const id=this.operation(acceptance),recovered=await this.readPasswordMutation(userId,id);if(recovered){if(recovered.kind!=='initial')throw invalid();return recovered;}
  const before=this.customer(this.row(userId));if(before.customer_password_state!=='unset')throw new CustomerIdentityError('password_already_set','A password is already set.');
  const salt=randomBytes(24).toString('hex'),hash=await derive(next,salt),timestamp=new Date().toISOString();
  return this.local.transaction(async transaction=>{
   const receipt=this.local.database.prepare('SELECT payload FROM ubeeq_customer_password_effects WHERE id=? AND user_id=?').get(id,userId) as {payload:string}|undefined;if(receipt)return JSON.parse(receipt.payload) as CustomerPasswordEffect;
   this.customer(this.row(userId));await acceptance?.accept(transaction);
   const result=this.local.database.prepare("UPDATE ubeeq_accounts SET password_hash=?,salt=?,customer_password_state='set',updated_at=? WHERE id=? AND account_scope='customer_account' AND status='active' AND email_verified=1 AND customer_password_state='unset' AND password_hash=? AND salt=? AND roles_json=? AND scopes_json=? AND email=?").run(hash.toString('hex'),salt,timestamp,userId,before.password_hash,before.salt,before.roles_json,before.scopes_json,before.email);
   if(result.changes!==1)throw new CustomerIdentityError('standard_sign_in_required','Password setup or current account authority changed.');return this.effect(id,userId,'initial');
  });
 }
 private async passwordRow(address:string,supplied:string):Promise<Row|undefined>{
  if(typeof supplied!=='string'||supplied.length>128)return undefined;
  const normalized=email(address),row=this.row(normalized,true),salt=row?.salt??'customer-dummy-salt',expected=Buffer.from(row?.password_hash??'00'.repeat(64),'hex'),actual=await derive(supplied,salt);
  if(!row||row.customer_password_state!=='set'||actual.length!==expected.length||!timingSafeEqual(actual,expected))return undefined;
  this.customer(row);const current=this.customer(this.row(row.id));if(!sameCredential(row,current))return undefined;return current;
 }
 async verifyPassword(address:string,supplied:string):Promise<CustomerIdentity|undefined>{const row=await this.passwordRow(address,supplied);return row?this.value(row):undefined;}
 async verifyPasswordForSession(address:string,supplied:string):Promise<CustomerPasswordSessionProof|undefined>{
  const row=await this.passwordRow(address,supplied);if(!row)return undefined;
  // Hash/salt stay solely in this private closure. A password/role/scope change
  // between verification and acceptance invalidates the proof, even after every
  // old SDK/Commerce session has already been revoked by that winning change.
  return Object.freeze({identity:Object.freeze(structuredClone(this.value(row))),accept:<T>(operation:()=>Promise<T>,acceptance:import('@ubeeq/auth').CustomerPasswordSessionAcceptance):Promise<T>=>this.local.transaction(async transaction=>{
   const current=this.customer(this.row(row.id));if(!sameCredential(row,current))throw new CustomerIdentityError('invalid_credentials','The password or current account authority changed.');
   if(typeof acceptance?.accept!=='function')throw invalid();await acceptance.accept(transaction);
   const accepted=this.customer(this.row(row.id));if(!sameCredential(row,accepted))throw new CustomerIdentityError('invalid_credentials','The password or current account authority changed.');
   return operation();
  })});
 }
 async changePassword(userId:string,previous:string,next:string,acceptance?:CustomerPasswordAcceptance):Promise<CustomerPasswordEffect>{
  await this.verifyConfiguration();password(next);const id=this.operation(acceptance),recovered=await this.readPasswordMutation(userId,id);if(recovered){if(recovered.kind!=='change')throw invalid();return recovered;}
  const before=this.customer(this.row(userId));if(before.customer_password_state!=='set')throw new CustomerIdentityError('standard_sign_in_required','Initial password setup is required.');
  if(typeof previous!=='string'||previous.length>128||!await this.verifyPassword(before.email,previous))throw new CustomerIdentityError('invalid_credentials','The current password is incorrect.');
  const salt=randomBytes(24).toString('hex'),hash=await derive(next,salt),timestamp=new Date().toISOString();
  return this.local.transaction(async transaction=>{
   const receipt=this.local.database.prepare('SELECT payload FROM ubeeq_customer_password_effects WHERE id=? AND user_id=?').get(id,userId) as {payload:string}|undefined;if(receipt)return JSON.parse(receipt.payload) as CustomerPasswordEffect;
   this.customer(this.row(userId));await acceptance?.accept(transaction);
   const result=this.local.database.prepare("UPDATE ubeeq_accounts SET password_hash=?,salt=?,updated_at=? WHERE id=? AND account_scope='customer_account' AND status='active' AND email_verified=1 AND customer_password_state='set' AND password_hash=? AND salt=? AND roles_json=? AND scopes_json=? AND email=?").run(hash.toString('hex'),salt,timestamp,userId,before.password_hash,before.salt,before.roles_json,before.scopes_json,before.email);
   if(result.changes!==1)throw new CustomerIdentityError('standard_sign_in_required','The password or current account authority changed.');
   this.local.database.prepare('UPDATE ubeeq_sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL').run(timestamp,userId);return this.effect(id,userId,'change');
  });
 }
}
