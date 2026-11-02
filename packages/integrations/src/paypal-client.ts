import { readBoundedResponseText } from './bounded-response-text.js';
import { parseRetryAfterSeconds } from './provider-errors.js';

export type PayPalEnvironment = 'sandbox' | 'live';
export type PayPalFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface PayPalCredentials { clientId: string; clientSecret: string; }
export interface PayPalWebhook { id: string; url: string; event_types: readonly { name: string }[]; }
export const PAYPAL_EVENT_TYPES = [
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.PENDING', 'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED', 'CHECKOUT.ORDER.APPROVED',
  'CHECKOUT.PAYMENT-APPROVAL.REVERSED', 'PAYMENT.REFUND.PENDING', 'PAYMENT.REFUND.FAILED',
  'CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'
] as const;

/** Safe to expose to the caller: never includes provider bodies, credentials or tokens. */
export class PayPalError extends Error {
  constructor(readonly code: string, readonly retryAfterSeconds?: number) { super(code); this.name = 'PayPalError'; }
}

const pathId = (id: string) => {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new PayPalError('invalid_provider_id');
  return encodeURIComponent(id);
};
const parseWebhook = (value: any): PayPalWebhook => {
  if (!value || typeof value.id !== 'string' || typeof value.url !== 'string' || !Array.isArray(value.event_types)
    || value.event_types.some((event: any) => typeof event?.name !== 'string')) throw new PayPalError('provider_invalid_response');
  pathId(value.id);
  return { id: value.id, url: value.url, event_types: value.event_types.map(({ name }: { name: string }) => ({ name })) };
};

/** Server-only REST client. Fixed origins, no redirects, bounded responses and expiring tokens. */
export class PayPalClient {
  private token?: { value: string; expiresAt: number };
  private readonly origin: string;
  constructor(readonly environment: PayPalEnvironment, private readonly credentials: PayPalCredentials,
    private readonly transport: PayPalFetch = fetch, private readonly now: () => number = Date.now) {
    if (!['sandbox', 'live'].includes(environment)) throw new PayPalError('invalid_environment');
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(credentials.clientId) || !credentials.clientSecret || credentials.clientSecret.length > 8192)
      throw new PayPalError('invalid_credentials');
    this.origin = environment === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }
  private async request(path: string, init: RequestInit): Promise<any> {
    let response: Response;
    try { response = await this.transport(this.origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new PayPalError('provider_outcome_unknown'); }
    if (!response.ok) {
      let details:any;
      try{details=JSON.parse(await readBoundedResponseText(response,65536));}catch{/* Never expose unrecognized provider data. */}
      const codes:Record<string,string>={WEBHOOK_NUMBER_LIMIT_EXCEEDED:'webhook_limit_reached',WEBHOOK_URL_ALREADY_EXISTS:'webhook_destination_conflict',PERMISSION_DENIED:'missing_permissions',AUTHENTICATION_FAILURE:'invalid_credentials',PAYEE_ACCOUNT_RESTRICTED:'merchant_action_required'};
      const issue=[details?.name,...(Array.isArray(details?.details)?details.details.map((item:any)=>item?.issue):[])].find(name=>typeof name==='string'&&Object.hasOwn(codes,name));
      throw new PayPalError(issue?codes[issue]:response.status === 401 ? 'invalid_credentials' : response.status === 403 ? 'missing_permissions'
        : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'provider_outcome_unknown' : 'provider_rejected',
      parseRetryAfterSeconds(response.headers.get('retry-after')));
    }
    if (response.status === 204) { await response.body?.cancel(); return undefined; }
    try { return JSON.parse(await readBoundedResponseText(response, 1024 * 1024)); }
    catch { throw new PayPalError('provider_invalid_response'); }
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    const started = this.now();
    const result = await this.request('/v1/oauth2/token', { method: 'POST', headers: {
      authorization: 'Basic ' + Buffer.from(this.credentials.clientId + ':' + this.credentials.clientSecret).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded'
    }, body: 'grant_type=client_credentials' });
    if (typeof result?.access_token !== 'string' || !result.access_token || /[\r\n]/.test(result.access_token)
      || result.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(result.expires_in) || result.expires_in <= 0)
      throw new PayPalError('provider_invalid_response');
    this.token = { value: result.access_token, expiresAt: started + Math.max(0, result.expires_in - 60) * 1000 };
    return this.token.value;
  }
  private async api(path: string, method = 'GET', body?: unknown, extraHeaders: Record<string, string> = {}): Promise<any> {
    const token = await this.accessToken();
    try { return await this.request(path, { method, headers: { ...extraHeaders, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
    catch (error) { if (error instanceof PayPalError && error.code === 'invalid_credentials') this.token = undefined; throw error; }
  }
  async listWebhooks(): Promise<readonly PayPalWebhook[]> {
    const result = await this.api('/v1/notifications/webhooks');
    if (!Array.isArray(result?.webhooks)) throw new PayPalError('provider_invalid_response');
    return result.webhooks.map(parseWebhook);
  }
  async createWebhook(url: string): Promise<PayPalWebhook> {
    return parseWebhook(await this.api('/v1/notifications/webhooks', 'POST', { url, event_types: PAYPAL_EVENT_TYPES.map(name => ({ name })) }));
  }
  async updateWebhook(id: string): Promise<PayPalWebhook> {
    return parseWebhook(await this.api('/v1/notifications/webhooks/' + pathId(id), 'PATCH',
      [{ op: 'replace', path: '/event_types', value: PAYPAL_EVENT_TYPES.map(name => ({ name })) }]));
  }
  async deleteWebhook(id: string): Promise<void> { await this.api('/v1/notifications/webhooks/' + pathId(id), 'DELETE'); }

  async createOrder(input: { reference: string; currency: string; amount: string; returnUrl: string; cancelUrl: string; requestId: string }) {
    return this.api('/v2/checkout/orders', 'POST', { intent: 'CAPTURE', purchase_units: [{ reference_id: input.reference,
      custom_id: input.reference, amount: { currency_code: input.currency, value: input.amount } }],
      payment_source: { paypal: { experience_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl,
        user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } } }, { 'PayPal-Request-Id': input.requestId, Prefer: 'return=representation' });
  }
  async getOrder(id: string) { return this.api('/v2/checkout/orders/' + pathId(id)); }
  async captureOrder(id: string, requestId: string) { return this.api('/v2/checkout/orders/' + pathId(id) + '/capture', 'POST', {}, { 'PayPal-Request-Id': requestId, Prefer: 'return=representation' }); }
  async getCapture(id: string) { return this.api('/v2/payments/captures/' + pathId(id)); }
  async getRefund(id: string) { return this.api('/v2/payments/refunds/' + pathId(id)); }
  async getDispute(id: string) { return this.api('/v1/customer/disputes/' + pathId(id)); }

  /** The receiver must pass original bytes; this client never fetches a supplied certificate URL. */
  async verifyWebhook(webhookId: string, headers: Headers, rawBody: Uint8Array): Promise<{ id: string; event_type: string; [key: string]: unknown }> {
    pathId(webhookId);
    if (!rawBody.byteLength || rawBody.byteLength > 1024 * 1024) throw new PayPalError('invalid_webhook_body');
    let event: any;
    try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); }
    catch { throw new PayPalError('invalid_webhook_body'); }
    if (!event || Array.isArray(event) || typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(event.id)
      || typeof event.event_type !== 'string' || event.event_type.length > 200) throw new PayPalError('invalid_webhook_body');
    const required = (name: string) => { const value = headers.get(name); if (!value || value.length > 8192 || /[\r\n]/.test(value)) throw new PayPalError('invalid_webhook_headers'); return value; };
    const certUrl = required('paypal-cert-url');
    let cert: URL;
    try { cert = new URL(certUrl); } catch { throw new PayPalError('invalid_certificate_url'); }
    // Certificate hosting is not the environment boundary; the fixed verification API and stored webhook ID are.
    if (cert.protocol !== 'https:' || !['api.paypal.com', 'api.sandbox.paypal.com'].includes(cert.hostname) || cert.port || cert.username || cert.password
      || !/^\/v1\/notifications\/certs\/[A-Za-z0-9_-]+$/.test(cert.pathname) || cert.search || cert.hash)
      throw new PayPalError('invalid_certificate_url');
    const result = await this.api('/v1/notifications/verify-webhook-signature', 'POST', {
      auth_algo: required('paypal-auth-algo'), cert_url: certUrl, transmission_id: required('paypal-transmission-id'),
      transmission_sig: required('paypal-transmission-sig'), transmission_time: required('paypal-transmission-time'),
      webhook_id: webhookId, webhook_event: event
    });
    if (result?.verification_status !== 'SUCCESS') throw new PayPalError('invalid_webhook_signature');
    return event;
  }
}
