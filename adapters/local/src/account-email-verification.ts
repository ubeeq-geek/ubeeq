import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {AccountEmailVerificationError,type AccountEmailVerificationPort,type AccountEmailVerificationStart,type LocalAccountEmailVerificationConfiguration} from '@ubeeq/auth';
import type {LocalIdentityAdapter,LocalSqliteDatabase} from './index.js';
interface Account{id:string;email:string;status:string;account_scope:string;created_at:string;password_hash:string;salt:string;email_verified:number}
interface Challenge{id:string;account_id:string;session_id:string;email:string;account_fingerprint:string;code_hash:string;created_at:string;expires_at:string;attempts:number;state:'active'|'superseded'|'consumed'|'exhausted';delivery_state:'pending'|'dispatching'|'sent'|'unknown'|'cancelled';consumed_at:string|null}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const invalid=()=>new AccountEmailVerificationError('invalid_email_challenge',403),unavailable=()=>new AccountEmailVerificationError('email_verification_unavailable',503);
const stamp=()=>new Date().toISOString();
/** No customer-email proof, caller identity DTO or stored verified claim is
 * accepted. Account mutation and one-use consumption share the real writer. */
export class LocalAccountEmailVerification implements AccountEmailVerificationPort{
 private readonly ttl:number;
 constructor(private readonly local:LocalSqliteDatabase,private readonly identity:LocalIdentityAdapter,private readonly configuration:LocalAccountEmailVerificationConfiguration){
  this.ttl=configuration.ttlSeconds??600;if(!configuration.mail||typeof configuration.mail.send!=='function'||!Number.isSafeInteger(this.ttl)||this.ttl<60||this.ttl>3600)throw unavailable();
 }
 private standalone(){if(this.local.currentTransactionId())throw unavailable();}
 private async current(credential:string){
  if(typeof credential!=='string'||!credential||credential.length>4096)throw new AccountEmailVerificationError('authentication_invalid',401);
  const session=await this.identity.verifySession({credential});if(!session)throw new AccountEmailVerificationError('authentication_invalid',401);
  if(session.subject.accountScope!=='creator_operator')throw new AccountEmailVerificationError('creator_access_denied',403);
  const row=this.local.database.prepare('SELECT id,email,status,account_scope,created_at,password_hash,salt,email_verified FROM ubeeq_accounts WHERE id=?').get(session.subject.id) as Account|undefined;
  if(!row||row.id!==session.subject.id||row.status!=='active'||row.account_scope!=='creator_operator'||row.email!==session.subject.email||typeof row.email!=='string'||!/^\S+@\S+\.\S+$/.test(row.email)||![0,1].includes(row.email_verified)||!Number.isFinite(Date.parse(row.created_at))||typeof row.password_hash!=='string'||typeof row.salt!=='string')throw unavailable();
  return{session,row,fingerprint:hash(JSON.stringify([this.local.configuration.cellId,row.id,row.created_at,row.email,row.account_scope,row.password_hash,row.salt]))};
 }
 private challenge(id:string):Challenge|undefined{
  const row=this.local.database.prepare('SELECT * FROM ubeeq_account_email_challenges WHERE id=?').get(id) as Challenge|undefined;
  if(row&&(!/^[a-f0-9]{64}$/.test(row.code_hash)||!/^[a-f0-9]{64}$/.test(row.account_fingerprint)||!Number.isInteger(row.attempts)||row.attempts<0||row.attempts>5||!['active','superseded','consumed','exhausted'].includes(row.state)||!['pending','dispatching','sent','unknown','cancelled'].includes(row.delivery_state)||!Number.isFinite(Date.parse(row.expires_at))||new Date(row.expires_at).toISOString()!==row.expires_at||!Number.isFinite(Date.parse(row.created_at))||new Date(row.created_at).toISOString()!==row.created_at||row.expires_at<=row.created_at||!row.account_id||!row.session_id||typeof row.email!=='string'||!/^\S+@\S+\.\S+$/.test(row.email)||row.state==='consumed'&&(!row.consumed_at||!Number.isFinite(Date.parse(row.consumed_at)))||row.state!=='consumed'&&row.consumed_at!==null))throw unavailable();return row;
 }
 async status(input:{credential:string}){return this.local.transaction(async()=>{const current=await this.current(input.credential);return{email:current.row.email,emailVerified:current.row.email_verified===1};});}
 async begin(input:{credential:string}):Promise<AccountEmailVerificationStart>{
  // Staging/delivery must never borrow a domain writer; otherwise a failed
  // outer transaction could erase a real sent message and attempt history.
  this.standalone();const prepared=await this.local.transaction(async()=>{
   const current=await this.current(input.credential);if(current.row.email_verified===1)return{verified:true as const};
   const time=Date.now(),recent=this.local.database.prepare('SELECT created_at FROM ubeeq_account_email_challenges WHERE account_id=? AND created_at>? ORDER BY created_at DESC').all(current.row.id,new Date(time-3600000).toISOString()) as Array<{created_at:string}>;
   if(recent.length>=5||recent.some(row=>!Number.isFinite(Date.parse(row.created_at))))throw new AccountEmailVerificationError('email_verification_throttled',429);
   if(recent[0]&&Date.parse(recent[0].created_at)>time-60000)throw new AccountEmailVerificationError('email_verification_throttled',429);
   const id=randomUUID(),code=randomBytes(32).toString('base64url'),createdAt=new Date(time).toISOString(),expiresAt=new Date(time+this.ttl*1000).toISOString();
   this.local.database.prepare("UPDATE ubeeq_account_email_challenges SET state='superseded' WHERE account_id=? AND state='active'").run(current.row.id);
   this.local.database.prepare("INSERT INTO ubeeq_account_email_challenges(id,account_id,session_id,email,account_fingerprint,code_hash,created_at,expires_at,attempts,state,delivery_state) VALUES(?,?,?,?,?,?,?,?,0,'active','pending')").run(id,current.row.id,current.session.id,current.row.email,current.fingerprint,hash(code),createdAt,expiresAt);
   return{verified:false as const,id,code,email:current.row.email,sessionId:current.session.id,fingerprint:current.fingerprint,expiresAt};
  });
  if(prepared.verified)return{emailVerified:true};
  await this.local.transaction(async()=>{const current=await this.current(input.credential),row=this.challenge(prepared.id);if(!row||row.state!=='active'||row.delivery_state!=='pending'||row.session_id!==current.session.id||current.session.id!==prepared.sessionId||row.account_id!==current.row.id||row.email!==current.row.email||row.account_fingerprint!==current.fingerprint||current.fingerprint!==prepared.fingerprint||row.expires_at<=stamp())throw invalid();const saved=this.local.database.prepare("UPDATE ubeeq_account_email_challenges SET delivery_state='dispatching' WHERE id=? AND state='active' AND delivery_state='pending'").run(row.id);if(saved.changes!==1)throw unavailable();});
  // Only the real configured mail transport sees this secret. No provider IO
  // is performed while holding any Local SQL transaction.
  try{const delivered=await this.configuration.mail.send({to:prepared.email,subject:'Verify your account email',text:'Account email verification\nChallenge: '+prepared.id+'\nCode: '+prepared.code+'\nExpires: '+prepared.expiresAt+'\nUse this code only while signed in to the account that requested it.',idempotencyKey:'account-email:'+prepared.id});if(delivered!==undefined)throw unavailable();}
  catch{await this.observeDelivery(prepared.id,prepared.fingerprint,'unknown');throw unavailable();}
  await this.observeDelivery(prepared.id,prepared.fingerprint,'sent');return{challengeId:prepared.id,expiresAt:prepared.expiresAt};
 }
 private async observeDelivery(id:string,fingerprint:string,state:'sent'|'unknown'){
  // Factual acknowledgment may persist after session/socket revocation. It
  // never marks an account verified and never starts/retries another send.
  await this.local.transaction(async()=>{const row=this.challenge(id);if(!row||row.account_fingerprint!==fingerprint||row.delivery_state!=='dispatching')throw unavailable();const saved=this.local.database.prepare('UPDATE ubeeq_account_email_challenges SET delivery_state=?,delivery_observed_at=? WHERE id=? AND delivery_state=\'dispatching\'').run(state,stamp(),id);if(saved.changes!==1)throw unavailable();});
 }
 async complete(input:{credential:string;challengeId:string;code:string}):Promise<{emailVerified:true}>{
  this.standalone();if(typeof input.challengeId!=='string'||input.challengeId.length>200||typeof input.code!=='string'||input.code.length>512)throw new AccountEmailVerificationError('invalid_email_verification_input',400);
  const accepted=await this.local.transaction(async()=>{
   const current=await this.current(input.credential),row=this.challenge(input.challengeId);
   if(!row||row.account_id!==current.row.id||row.session_id!==current.session.id||row.email!==current.row.email||row.account_fingerprint!==current.fingerprint||row.state!=='active'||row.attempts>=5||row.expires_at<=stamp()||!['dispatching','sent','unknown'].includes(row.delivery_state))return false;
   const supplied=Buffer.from(hash(input.code),'hex'),expected=Buffer.from(row.code_hash,'hex');
   if(!timingSafeEqual(supplied,expected)){const attempts=row.attempts+1;const denied=this.local.database.prepare('UPDATE ubeeq_account_email_challenges SET attempts=?,state=? WHERE id=? AND state=\'active\' AND attempts=?').run(attempts,attempts===5?'exhausted':'active',row.id,row.attempts);if(denied.changes!==1)throw unavailable();return false;}
   const time=stamp(),updated=this.local.database.prepare("UPDATE ubeeq_accounts SET email_verified=1,updated_at=? WHERE id=? AND email=? AND account_scope='creator_operator' AND status='active' AND created_at=? AND password_hash=? AND salt=?").run(time,current.row.id,current.row.email,current.row.created_at,current.row.password_hash,current.row.salt);
   if(updated.changes!==1)throw unavailable();const consumed=this.local.database.prepare("UPDATE ubeeq_account_email_challenges SET state='consumed',consumed_at=? WHERE id=? AND state='active' AND attempts=?").run(time,row.id,row.attempts);if(consumed.changes!==1)throw unavailable();return true;
  });
  // Denied attempts commit before this error. An outer Raw is rejected above.
  if(!accepted)throw invalid();return{emailVerified:true};
 }
}
