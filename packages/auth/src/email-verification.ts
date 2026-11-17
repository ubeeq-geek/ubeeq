/** Actual account email proof, separate from Commerce customer/recovery email. */
export interface AccountEmailVerificationStatus {email:string;emailVerified:boolean}
export type AccountEmailVerificationStart={emailVerified:true}|{challengeId:string;expiresAt:string};
/** Only the trusted delivery transport receives the secret message body. */
export interface AccountEmailVerificationMail {send(input:{to:string;subject:string;text:string;idempotencyKey:string}):Promise<void>}
export interface LocalAccountEmailVerificationConfiguration {mail:AccountEmailVerificationMail;ttlSeconds?:number}
export interface AccountEmailVerificationPort {
 status(input:{credential:string}):Promise<AccountEmailVerificationStatus>;
 begin(input:{credential:string}):Promise<AccountEmailVerificationStart>;
 complete(input:{credential:string;challengeId:string;code:string}):Promise<{emailVerified:true}>;
}
export class AccountEmailVerificationError extends Error {
 constructor(readonly code:'authentication_invalid'|'creator_access_denied'|'invalid_email_challenge'|'email_verification_throttled'|'email_verification_unavailable'|'invalid_email_verification_input',readonly status:number){super(code==='authentication_invalid'?'The current session is invalid or expired.':code==='creator_access_denied'?'An active operator account is required.':code==='email_verification_throttled'?'Wait before requesting another verification message.':code==='invalid_email_challenge'?'The email verification challenge is invalid, expired or already used.':code==='invalid_email_verification_input'?'Use the original challenge and verification code.':'Email verification is unavailable.');this.name='AccountEmailVerificationError';}
}
