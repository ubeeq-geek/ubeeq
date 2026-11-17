import type {IdentityAccount} from './index.js';
import type {PrincipalAccountScope} from '@ubeeq/extension-sdk';

/** Current provider facts, never a token assertion or a local memory profile. */
export interface CustomerIdentity {
 userId:string;email:string;emailVerified:boolean;accountScope:PrincipalAccountScope;
 provider:'local'|'cognito';providerUsername:string;account:IdentityAccount;
 passwordSetupRequired:boolean;standardSignInRequired:boolean;
}
export class CustomerIdentityError extends Error {
 constructor(readonly code:'unavailable'|'standard_sign_in_required'|'invalid_credentials'|'invalid_password'|'password_already_set',message:string){super(message);this.name='CustomerIdentityError';}
}
/** Provider-local accepting transaction, never a fabricated cross-provider tx. */
export interface CustomerIdentityTransaction {readonly id:string}
export interface CustomerPasswordAcceptance {operationId:string;accept(transaction?:CustomerIdentityTransaction):Promise<void>}
/** Opaque server-only result of real password verification. It contains no
 * credential witness in its serializable identity. accept() rechecks that exact
 * private credential inside the actual provider writer while the host joins its
 * current profile/member authority and accepts the session. Not a bearer token. */
export interface CustomerPasswordSessionAcceptance {accept(transaction:CustomerIdentityTransaction):Promise<void>}
export interface CustomerPasswordSessionProof {
 readonly identity:CustomerIdentity;
 accept<T>(operation:()=>Promise<T>,acceptance:CustomerPasswordSessionAcceptance):Promise<T>;
}
/** Actual acknowledged provider effect; contains no password or password hash. */
export interface CustomerPasswordEffect {schemaVersion:1;operationId:string;userId:string;provider:'local'|'cognito';kind:'initial'|'change';appliedAt:string;providerRequestId?:string}
/** Trusted server lifecycle called from a verified commerce-email proof. It
 * creates a NEW customer-scoped principal directly; it never turns an existing
 * operator into a customer or accepts caller-selected user IDs/role claims.
 * Existing Native credentials/subjects require their explicit fenced migration.
 */
export interface CustomerIdentityProvider {
 readonly provider:'local'|'cognito';
 /** Actual schema/client configuration; an unsupported realm fails closed. */
 verifyConfiguration():Promise<void>;
 findByEmail(email:string):Promise<CustomerIdentity|undefined>;
 current(userId:string):Promise<CustomerIdentity|undefined>;
 provisionVerifiedEmail(email:string):Promise<CustomerIdentity>;
 setInitialPassword(userId:string,password:string,acceptance?:CustomerPasswordAcceptance):Promise<CustomerPasswordEffect>;
 verifyPassword(email:string,password:string):Promise<CustomerIdentity|undefined>;
 /** Local session creation requires this real accepting witness. Its absence is
  * unavailable, never permission to issue from a stale verification DTO. */
 verifyPasswordForSession?(email:string,password:string):Promise<CustomerPasswordSessionProof|undefined>;
 changePassword(userId:string,current:string,next:string,acceptance?:CustomerPasswordAcceptance):Promise<CustomerPasswordEffect>;
 /** Actual durable provider receipt where supported; undefined never proves an
  * ambiguous external provider call had no effect. */
 readPasswordMutation?(userId:string,operationId:string):Promise<CustomerPasswordEffect|undefined>;
}
