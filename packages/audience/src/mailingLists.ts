import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Grant, MailingOffer, MailingProfile, MailingRecord, MailingRepository, MailingSubscriber } from './types.js';
import { MailingListError } from './errors.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export const mailingInitial = (): MailingProfile => ({
  id: 'profile',
  revision: 0,
  enabled: false,
  title: 'Letters and updates',
  description: '',
  offers: [],
});

export const mailingConsent = (profile: MailingProfile) =>
  `Receive ${profile.title} emails from ${profile.senderName ?? profile.title}. Unsubscribe at any time.`;

export const validateAudienceEmail = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new MailingListError(422, 'Enter a valid email address.');
  }
  return normalized;
};

const escapeCsvField = (input: unknown): string => {
  let v = String(input ?? '');
  if (/^[\s]*[=+@-]/.test(v)) {
    v = "'" + v;
  }
  return '"' + v.replace(/"/g, '""') + '"';
};

export const exportSubscribersToCsv = (subscribers: MailingSubscriber[]): string => {
  const rows: unknown[][] = [['Email', 'Status', 'Confirmed at (UTC)', 'Consent text']];
  for (const subscriber of subscribers) {
    if (subscriber.status === 'active') {
      rows.push([subscriber.email, subscriber.status, subscriber.confirmedAt ?? '', subscriber.consentText ?? '']);
    }
  }
  return '\uFEFF' + rows.map((r) => r.map(escapeCsvField).join(',')).join('\r\n') + '\r\n';
};

export class MailingListService {
  constructor(
    readonly repository: MailingRepository,
    private sendEmail: (email: string, subject: string, message: string) => Promise<void>,
    private appOrigin: string,
    private now = Date.now
  ) {}

  async profile(creator: string): Promise<MailingProfile> {
    return (await this.repository.get<MailingProfile>(creator, 'profile', 'profile')) ?? mailingInitial();
  }

  async mutate<T extends MailingRecord, R>(
    creator: string,
    kind: string,
    id: string,
    initial: () => T,
    fn: (row: T) => R
  ): Promise<R> {
    for (let retry = 0; ; retry++) {
      const row = (await this.repository.get<T>(creator, kind, id)) ?? initial();
      const expected = row.revision;
      const result = fn(row);
      row.revision++;
      try {
        await this.repository.save(creator, kind, row, expected);
        return result;
      } catch (e) {
        if (!(e instanceof MailingListError) || e.status !== 409 || retry >= 3) {
          throw e;
        }
      }
    }
  }

  private link(creator: string, path: string, token: string): string {
    let url: URL;
    try {
      url = new URL('/mailing/' + encodeURIComponent(creator) + path, this.appOrigin);
    } catch {
      throw new MailingListError(503, 'The platform application URL is not configured.');
    }
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw new MailingListError(503, 'The platform application URL is not configured.');
    }
    url.hash = token;
    return url.href;
  }

  async subscribe(
    creator: string,
    input: { email?: unknown; offerId?: unknown; consent?: unknown },
    ip: string
  ): Promise<{ message: string }> {
    const profile = await this.profile(creator);
    if (!profile.enabled) {
      throw new MailingListError(404, 'This mailing list is unavailable.');
    }
    if (input.consent !== true) {
      throw new MailingListError(422, 'Choose to receive emails before subscribing.');
    }
    const email = validateAudienceEmail(input.email);
    const id = digest(email);
    const now = this.now();
    const token = randomBytes(32).toString('base64url');
    const offerId = typeof input.offerId === 'string' && input.offerId ? input.offerId : undefined;
    if (offerId && !profile.offers.some((o) => o.id === offerId && o.enabled)) {
      throw new MailingListError(404, 'This offer is unavailable.');
    }

    const bucket = String(Math.floor(now / 3600000));
    const rateId = digest(ip) + '.' + bucket;
    await this.mutate<MailingRecord & { count: number }, void>(
      creator,
      'rate',
      rateId,
      () => ({ id: rateId, revision: 0, count: 0 }),
      (r) => {
        if (r.count >= 20) {
          throw new MailingListError(429, 'Please wait before trying again.');
        }
        r.count++;
      }
    );

    const consentText = mailingConsent(profile);
    await this.mutate<MailingSubscriber, void>(
      creator,
      'subscriber',
      id,
      () => ({ id, revision: 0, email, status: 'pending', createdAt: new Date(now).toISOString(), requestTimes: [] }),
      (row) => {
        row.requestTimes = row.requestTimes.filter((time) => time > now - 3600000);
        if (row.requestTimes.length >= 5 || (row.lastRequestedAt !== undefined && row.lastRequestedAt > now - 60000)) {
          throw new MailingListError(429, 'Please wait before requesting another confirmation.');
        }
        row.requestTimes.push(now);
        row.lastRequestedAt = now;
        row.pending = { hash: digest(token), offerId, expiresAt: now + 86400000, consentText };
      }
    );

    const url = this.link(creator, '/confirm/' + id, token);
    try {
      await this.sendEmail(
        email,
        'Confirm your mailing-list signup',
        `Confirm that you want to receive emails from ${profile.title}:\n\n${url}\n\n${consentText}\nThis link expires in 24 hours. If you did not request this signup, ignore this email.`
      );
    } catch {
      throw new MailingListError(503, 'The confirmation email could not be delivered. Please try again later.');
    }
    return { message: 'Check your inbox to confirm your signup. No subscription is activated until you confirm.' };
  }

  async confirm(
    creator: string,
    id: string,
    token: string
  ): Promise<{
    message: string;
    notification: string;
    unsubscribeUrl: string;
    grantId?: string;
    token?: string;
    offer?: { id: string; title: string; assetIds: string[] };
    expiresAt?: string;
  }> {
    const profile = await this.profile(creator);
    if (!profile.enabled) {
      throw new MailingListError(404, 'This mailing list is unavailable.');
    }
    const now = this.now();
    const grantId = randomUUID();
    const grantToken = randomBytes(32).toString('base64url');

    const subscriber = await this.mutate<MailingSubscriber, MailingSubscriber>(
      creator,
      'subscriber',
      id,
      () => {
        throw new MailingListError(401, 'This confirmation is invalid or expired.');
      },
      (row) => {
        if (!row.pending || row.pending.expiresAt <= now || row.pending.hash !== digest(token)) {
          throw new MailingListError(401, 'This confirmation is invalid or expired.');
        }
        row.status = 'active';
        row.confirmedAt = new Date(now).toISOString();
        row.consentText = row.pending.consentText;
        row.unsubscribeToken ??= randomBytes(32).toString('base64url');
        return { ...row };
      }
    );

    const offer = profile.offers.find((o) => o.id === subscriber.pending?.offerId && o.enabled);
    let grant: Grant | undefined;
    if (offer) {
      grant = {
        id: grantId,
        revision: 1,
        email: subscriber.email,
        offerId: offer.id,
        hash: digest(grantToken),
        expiresAt: now + 604800000,
      };
      await this.repository.save(creator, 'grant', grant, 0);
    }

    await this.mutate<MailingSubscriber, void>(
      creator,
      'subscriber',
      id,
      () => {
        throw new MailingListError(401, 'This confirmation is invalid or expired.');
      },
      (row) => {
        if (row.pending?.hash === digest(token)) {
          row.pending = undefined;
        }
      }
    );

    const unsubscribeUrl = this.link(creator, '/unsubscribe/' + id, subscriber.unsubscribeToken!);
    const downloadUrl = grant ? this.link(creator, '/download/' + grant.id, grantToken) : undefined;
    let notification = 'sent';
    try {
      await this.sendEmail(
        subscriber.email,
        'Your signup is confirmed',
        `You are subscribed to ${profile.title}.${
          offer && downloadUrl
            ? '\n\nYour offer: ' + offer.title + '\n' + downloadUrl + '\nThe download link is available for seven days.'
            : ''
        }\n\nUnsubscribe at any time:\n${unsubscribeUrl}`
      );
    } catch {
      notification = 'failed';
    }

    return {
      message:
        subscriber.pending?.offerId && !offer
          ? 'Your signup is confirmed. The selected offer is no longer available.'
          : 'Your signup is confirmed.',
      notification,
      unsubscribeUrl,
      ...(grant
        ? {
            grantId: grant.id,
            token: grantToken,
            offer: { id: offer!.id, title: offer!.title, assetIds: offer!.assetIds },
            expiresAt: new Date(grant.expiresAt).toISOString(),
          }
        : {}),
    };
  }

  async unsubscribe(creator: string, id: string, token: string): Promise<{ message: string }> {
    await this.mutate<MailingSubscriber, void>(
      creator,
      'subscriber',
      id,
      () => {
        throw new MailingListError(401, 'This unsubscribe link is invalid.');
      },
      (row) => {
        if (!row.unsubscribeToken || row.unsubscribeToken !== token) {
          throw new MailingListError(401, 'This unsubscribe link is invalid.');
        }
        row.status = 'unsubscribed';
        row.pending = undefined;
      }
    );
    return { message: 'You have been unsubscribed. You can sign up again at any time.' };
  }

  async grant(creator: string, id: string, token: string): Promise<{ grant: Grant; offer: MailingOffer }> {
    const profile = await this.profile(creator);
    const grant = await this.repository.get<Grant>(creator, 'grant', id);
    if (!profile.enabled || !grant || grant.expiresAt <= this.now() || grant.hash !== digest(token)) {
      throw new MailingListError(401, 'This download link is invalid or expired.');
    }
    const offer = profile.offers.find((o) => o.id === grant.offerId && o.enabled);
    if (!offer) {
      throw new MailingListError(403, 'This offer is no longer available.');
    }
    return { grant, offer };
  }
}
