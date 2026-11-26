import { createHash } from 'node:crypto';
import type { Grant, MailingOffer, MailingProfile, MailingRepository } from './types.js';
import { MailingListError } from './errors.js';
import { mailingInitial } from './mailingLists.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export class FreeOfferService {
  constructor(
    private readonly repository: MailingRepository,
    private readonly now = Date.now
  ) {}

  async listOffers(creatorId: string): Promise<MailingOffer[]> {
    const profile = (await this.repository.get<MailingProfile>(creatorId, 'profile', 'profile')) ?? mailingInitial();
    return profile.offers;
  }

  async getOffer(creatorId: string, offerId: string): Promise<MailingOffer | undefined> {
    const offers = await this.listOffers(creatorId);
    return offers.find((o) => o.id === offerId);
  }

  async verifyGrantDownload(
    creatorId: string,
    grantId: string,
    token: string
  ): Promise<{ grant: Grant; offer: MailingOffer }> {
    const profile = await this.repository.get<MailingProfile>(creatorId, 'profile', 'profile');
    if (!profile || !profile.enabled) {
      throw new MailingListError(404, 'Mailing list is unavailable.');
    }

    const grant = await this.repository.get<Grant>(creatorId, 'grant', grantId);
    if (!grant || grant.expiresAt <= this.now() || grant.hash !== digest(token)) {
      throw new MailingListError(401, 'Download link is invalid or expired.');
    }

    const offer = profile.offers.find((o) => o.id === grant.offerId && o.enabled);
    if (!offer) {
      throw new MailingListError(403, 'This offer is no longer available.');
    }

    return { grant, offer };
  }
}
