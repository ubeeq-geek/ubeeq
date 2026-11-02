import { amountToMinor, minorToAmount, CommerceError, type Checkout, type CommerceProvider, type Offer, type PaymentEvidence, type Scope } from '@ubeeq/commerce';
import { PayPalClient, type PayPalFetch } from './paypal-client.js';

export interface PayPalCommercePorts {
  publicBaseUrl: string; fetch?: PayPalFetch;
  /** Restricted vault resolver must check deployment/creator/environment and support explicitly draining connections. */
  credentials(scope: Scope, connectionId: string): Promise<{ clientId: string; clientSecret: string; merchantId?: string }>;
}
/** Only independently retrieved provider resources are converted into payment evidence. */
export class PayPalCommerceProvider implements CommerceProvider {
  constructor(private readonly ports: PayPalCommercePorts) {}
  private async client(scope: Scope, connectionId: string) { return new PayPalClient(scope.environment, await this.ports.credentials(scope, connectionId), this.ports.fetch); }
  async createOrder(order: Checkout, _offer: Offer) {
    const client = await this.client(order, order.connectionId), base = this.ports.publicBaseUrl.replace(/\/$/, '');
    const result = await client.createOrder({ reference: order.reference, currency: order.currency, amount: minorToAmount(order.amountMinor, order.currency),
      returnUrl: base + '/commerce/checkout/' + order.id, cancelUrl: base + '/commerce/checkout/' + order.id + '?cancelled=1', requestId: order.reference });
    const snapshot = await client.getOrder(result.id), unit = snapshot.purchase_units?.[0];
    if (snapshot.id !== result.id || snapshot.purchase_units?.length !== 1 || unit?.custom_id !== order.reference || unit?.amount?.currency_code !== order.currency
      || amountToMinor(unit.amount.value, order.currency) !== order.amountMinor || !unit.payee?.merchant_id) throw new CommerceError('provider_order_snapshot_mismatch');
    const approval = result.links?.find((link: any) => ['payer-action', 'approve'].includes(link.rel))?.href;
    if (typeof approval !== 'string') throw new CommerceError('provider_approval_missing');
    return { orderId: result.id, approvalUrl: approval, merchantId: unit.payee.merchant_id };
  }
  async capture(order: Checkout) {
    const client = await this.client(order, order.connectionId);
    // A previous attempt may have captured before its response was lost, including outside the provider idempotency window.
    const current = await client.getOrder(order.providerOrderId!);
    if (current.status === 'COMPLETED' && current.purchase_units?.some((unit: any) => unit.payments?.captures?.length)) return;
    if (current.status !== 'APPROVED') throw new CommerceError('provider_order_not_approved', 409);
    await client.captureOrder(order.providerOrderId!, order.captureRequestId);
  }
  async orderStatus(order: Checkout): Promise<'pending' | 'approved' | 'failed'> {
    const remote = await (await this.client(order, order.connectionId)).getOrder(order.providerOrderId!);
    if (remote.id !== order.providerOrderId) throw new CommerceError('provider_order_snapshot_mismatch');
    return remote.status === 'VOIDED' ? 'failed' : remote.status === 'APPROVED' ? 'approved' : 'pending';
  }
  async reconcile(scope: Scope, connectionId: string, reference: { orderId?: string; captureId?: string; eventId?: string; eventType?: string; payload?: string }): Promise<PaymentEvidence[]> {
    const credentials = await this.ports.credentials(scope, connectionId), client = new PayPalClient(scope.environment, credentials, this.ports.fetch);
    const event = reference.payload ? JSON.parse(reference.payload) : undefined;
    let captureId = reference.captureId, orderId = reference.orderId, refund: any, dispute: any;
    if (event && event.id !== reference.eventId) throw new CommerceError('event_reference_mismatch');
    if (event && reference.eventType?.startsWith('CUSTOMER.DISPUTE.')) {
      dispute = await client.getDispute(event.resource?.dispute_id);
      const seller = dispute.disputed_transactions?.filter((t: any) => t.seller_transaction_id);
      if (!seller?.length) throw new CommerceError('dispute_capture_missing');
      const results: PaymentEvidence[] = [];
      for (const transaction of seller) results.push(...await this.reconcile(scope, connectionId, { captureId: transaction.seller_transaction_id }));
      return results.map(r => ({ ...r, dispute: dispute.status }));
    }
    if (event && (reference.eventType?.startsWith('PAYMENT.REFUND.') || reference.eventType === 'PAYMENT.CAPTURE.REFUNDED')) {
      refund = await client.getRefund(event.resource?.id);
      if (refund.id !== event.resource?.id) throw new CommerceError('refund_identity_mismatch');
      // Use only an exact fixed PayPal API refund relation; never follow the supplied URL.
      const up = refund.links?.find((link: any) => link.rel === 'up')?.href;
      let url: URL; try { url = new URL(up); } catch { throw new CommerceError('refund_capture_missing'); }
      if (url.protocol !== 'https:' || !['api.paypal.com','api-m.paypal.com','api.sandbox.paypal.com','api-m.sandbox.paypal.com'].includes(url.hostname)
        || !/^\/v2\/payments\/captures\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw new CommerceError('refund_capture_missing');
      captureId = url.pathname.split('/').at(-1);
    } else if (event && reference.eventType?.startsWith('PAYMENT.CAPTURE.')) captureId = event.resource?.id;
    else if (event) return []; // Unknown signed events are retained, never used to grant access.
    let captures: any[] = [];
    if (captureId) {
      const capture = await client.getCapture(captureId); if (capture.id !== captureId) throw new CommerceError('capture_identity_mismatch');
      orderId = capture.supplementary_data?.related_ids?.order_id;
      if (!orderId) throw new CommerceError('capture_order_missing'); captures = [capture];
    }
    if (!orderId) return [];
    const order = await client.getOrder(orderId);
    if (order.id !== orderId || order.purchase_units?.length !== 1) throw new CommerceError('unsupported_provider_order');
    const unit = order.purchase_units[0];
    if (credentials.merchantId && credentials.merchantId !== unit.payee?.merchant_id) throw new CommerceError('provider_merchant_mismatch');
    if (!captures.length) {
      for (const capture of unit.payments?.captures ?? []) captures.push(await client.getCapture(capture.id));
    }
    const results: PaymentEvidence[] = [];
    for (const capture of captures) {
      if (!(unit.payments?.captures ?? []).some((c: any) => c.id === capture.id) || capture.amount?.currency_code !== unit.amount?.currency_code) throw new CommerceError('capture_order_mismatch');
      const currency = capture.amount.currency_code;
      if (refund && refund.amount?.currency_code !== currency) throw new CommerceError('refund_currency_mismatch');
      const states: Record<string, PaymentEvidence['status']> = { COMPLETED: 'completed', PENDING: 'pending', DECLINED: 'failed', FAILED: 'failed', PARTIALLY_REFUNDED: 'partially_refunded', REFUNDED: 'refunded' };
      let status = states[capture.status]; if (!status) throw new CommerceError('unsupported_capture_state');
      // A verified reversal still requires independent capture/order/payee verification above.
      if (reference.eventType === 'PAYMENT.CAPTURE.REVERSED' && event.resource?.id === capture.id) status = 'reversed';
      const quantityUnsupported = unit.items?.some((item: any) => item.quantity !== '1');
      const breakdown = unit.amount?.breakdown ?? {};
      const adjustable = ['tax_total','shipping','handling','insurance','shipping_discount','discount'].some(name => breakdown[name] && amountToMinor(breakdown[name].value, currency) !== 0);
      const mappingId = unit.items?.length === 1 ? unit.items[0].sku : undefined;
      const paidMinor = amountToMinor(capture.amount.value, currency);
      results.push({ captureId: capture.id, orderId, reference: unit.custom_id, mappingId, merchantId: unit.payee?.merchant_id,
        currency, paidMinor, refundedMinor: status === 'refunded' ? paidMinor : 0, status, updatedAt: capture.update_time ?? capture.create_time,
        buyerEmail: order.payer?.email_address ?? order.payment_source?.paypal?.email_address,
        unsupported: !!(quantityUnsupported || adjustable || (unit.payments?.captures?.length ?? 0) > 1 || amountToMinor(unit.amount.value, currency) !== paidMinor),
        ...(refund ? { refunds: [{ id: refund.id, amountMinor: amountToMinor(refund.amount.value, currency), state: refund.status }] } : {}) });
    }
    return results;
  }
}
