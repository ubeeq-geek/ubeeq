export type Environment = 'sandbox' | 'live';
export interface Scope { deploymentId: string; ownerId: string; environment: Environment; }
export interface RecordBase extends Scope { id: string; createdAt: string; updatedAt: string; }
export interface Customer extends RecordBase { subjectId: string; verifiedEmails: string[]; discordUserId?: string; erasedAt?: string; }
export type Benefit = { type: 'gallery' | 'download' | 'package'; resourceId: string } | { type: 'discord_role'; resourceId: string; guildId: string; roleId: string };
export interface Offer extends RecordBase {
  offerId: string; version: number; slug: string; title: string; description: string; supportEmail: string;
  connectionId: string; merchantId: string; currency: string; amountMinor: number;
  benefits: Benefit[]; files: string[]; previews: string[]; terms: string; durationSeconds?: number;
  published: boolean; external?: { url: string; mappingId: string; validatedAt?: string; evidenceId?: string };
}
export interface Checkout extends RecordBase {
  customerId: string; offerVersionId: string; connectionId: string; merchantId: string;
  currency: string; amountMinor: number; reference: string; idempotencyKey: string;
  providerOrderId?: string; approvalUrl?: string; state: 'creating' | 'pending' | 'completed' | 'failed' | 'needs_review';
  captureRequestId: string; reviewReason?: string;
}
export type PaymentState = 'pending' | 'completed' | 'failed' | 'partially_refunded' | 'refunded' | 'reversed' | 'needs_review';
export interface Payment extends RecordBase {
  connectionId: string; merchantId: string; providerPaymentId: string; providerOrderId?: string;
  checkoutId?: string; offerVersionId?: string; currency: string; paidMinor: number; refundedMinor: number;
  state: PaymentState; providerUpdatedAt: string; reviewReason?: string; dispute?: string;
  notificationEventId?: string;
}
export interface Refund extends RecordBase { paymentId: string; providerRefundId: string; amountMinor: number; state: string; }
export interface Purchase extends RecordBase {
  paymentId: string; offerVersionId: string; customerId?: string; buyerEmail?: string;
  state: 'active' | 'revoked'; claimedAt?: string;
}
export interface Entitlement extends RecordBase {
  customerId?: string; purchaseId?: string; source: 'payment' | 'manual'; reason?: string;
  benefit: Benefit; startsAt: string; endsAt?: string; state: 'active' | 'revoked';
  assetIds: string[];
}
export interface Claim extends RecordBase {
  purchaseId: string; email: string; tokenHash: string; expiresAt: string; consumedAt?: string;
}
export interface EmailProof extends RecordBase { customerId: string; email: string; tokenHash: string; expiresAt: string; consumedAt?: string; }
export interface EmailLogin extends RecordBase { subjectId: string; email: string; tokenHash: string; expiresAt: string; consumedAt?: string; }
export interface CustomerSession extends RecordBase { customerId: string; tokenHash: string; expiresAt: string; }
export interface PrivateAsset extends RecordBase {
  label: string; contentType: string; byteLength: number; checksum: string; objectId: string;
  state: 'available' | 'unavailable' | 'preparing'; publicPreview: boolean;
}
export interface PackageRecord extends RecordBase { offerVersionId: string; assetId: string; state: 'preparing' | 'ready' | 'unavailable'; }
export interface DeliveryJob extends RecordBase {
  kind: 'create_order' | 'capture' | 'event' | 'reconcile' | 'claim_email' | 'verify_email' | 'login_email' | 'creator_notice' | 'discord' | 'package' | 'cleanup';
  referenceId: string; state: 'pending' | 'running' | 'done' | 'failed'; attempts: number; dueAt: string;
  leaseId?: string; leaseUntil?: string; lastError?: string; eventType?: string;
}
export interface ProviderEvent extends RecordBase { connectionId: string; eventId: string; eventType: string; verification:'verified'; attempts:number; payload?: string; payloadExpiresAt: string; state: 'pending' | 'processed' | 'needs_review'; lastError?: string; }
export interface Audit extends RecordBase { actorId: string; action: string; resourceId: string; reason?: string; }
export interface RateLimit extends RecordBase { count: number; windowAt: string; }
export interface DiscordGuild extends RecordBase { guildId: string; roleIds: string[]; roleLabels?: Record<string,string>; inviteUrl: string; }
export interface DiscordRole extends RecordBase {
  customerId: string; discordUserId: string; guildId: string; roleId: string;
  managed: boolean; preexisting: boolean; desired: boolean; actual: boolean;
  status: 'pending' | 'delivered' | 'needs_membership' | 'conflict'; lastError?: string;
}
export interface OAuthState extends RecordBase { customerId: string; creatorSubjectId?: string; tokenHash: string; expiresAt: string; consumedAt?: string; }
export interface DiscordSetup extends RecordBase { customerId: string; subjectId: string; credentialReference: string; expiresAt: string; }
export interface CommerceRecords {
  customer: Customer; offer: Offer; checkout: Checkout; payment: Payment; refund: Refund; purchase: Purchase;
  entitlement: Entitlement; claim: Claim; emailProof: EmailProof; asset: PrivateAsset; package: PackageRecord;
  job: DeliveryJob; event: ProviderEvent; audit: Audit; rate: RateLimit; guild: DiscordGuild; discordRole: DiscordRole; oauth: OAuthState;
  login: EmailLogin; session: CustomerSession;
  discordSetup: DiscordSetup;
}
/** The callback is synchronous: remote operations must never occur inside a database transaction. */
export interface CommerceTransaction {
  get<K extends keyof CommerceRecords>(kind: K, id: string): CommerceRecords[K] | undefined;
  list<K extends keyof CommerceRecords>(kind: K): CommerceRecords[K][];
  insert<K extends keyof CommerceRecords>(kind: K, record: CommerceRecords[K], uniqueKeys?: string[]): void;
  put<K extends keyof CommerceRecords>(kind: K, record: CommerceRecords[K]): void;
  remove<K extends keyof CommerceRecords>(kind: K, id: string): void;
}
export interface CommerceStore {
  readonly deploymentId: string;
  transaction<T>(operation: (tx: CommerceTransaction) => T): Promise<T>;
}
export class CommerceError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); this.name = 'CommerceError'; }
}
export const currencyExponent = (currency: string): number => {
  // PayPal-supported currencies; three-decimal and unsupported currency configurations fail closed.
  if (['JPY', 'HUF', 'TWD'].includes(currency)) return 0;
  if (['AUD','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP','HKD','ILS','MXN','MYR','NOK','NZD','PHP','PLN','SEK','SGD','THB','USD'].includes(currency)) return 2;
  throw new CommerceError('unsupported_currency');
};
export const amountToMinor = (value: string, currency: string): number => {
  const exponent = currencyExponent(currency);
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new CommerceError('invalid_amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent))) throw new CommerceError('invalid_amount_precision');
  const result = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.slice(0, exponent).padEnd(exponent, '0') || '0');
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new CommerceError('invalid_amount');
  return Number(result);
};
export const minorToAmount = (value: number, currency: string): string => {
  if (!Number.isSafeInteger(value) || value < 0) throw new CommerceError('invalid_amount');
  const exponent = currencyExponent(currency), digits = String(value).padStart(exponent + 1, '0');
  return exponent ? digits.slice(0, -exponent) + '.' + digits.slice(-exponent) : digits;
};
