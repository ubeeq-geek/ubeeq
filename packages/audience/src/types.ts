export interface MailingOffer {
  id: string;
  title: string;
  description: string;
  assetIds: string[];
  assetWorkIds: Record<string, string>;
  enabled: boolean;
}

export interface MailingRecord {
  id: string;
  revision: number;
}

export interface MailingProfile extends MailingRecord {
  enabled: boolean;
  title: string;
  senderName?: string;
  description: string;
  offers: MailingOffer[];
}

export interface MailingSubscriber extends MailingRecord {
  email: string;
  status: 'pending' | 'active' | 'unsubscribed';
  createdAt: string;
  confirmedAt?: string;
  consentText?: string;
  unsubscribeToken?: string;
  lastRequestedAt?: number;
  requestTimes: number[];
  pending?: {
    hash: string;
    offerId?: string;
    expiresAt: number;
    consentText: string;
  };
}

export interface Grant extends MailingRecord {
  email: string;
  offerId: string;
  hash: string;
  expiresAt: number;
}

export interface MailingRepository {
  get<T extends MailingRecord>(creator: string, kind: string, id: string): Promise<T | undefined>;
  save(creator: string, kind: string, value: MailingRecord, expected: number): Promise<void>;
  list<T extends MailingRecord>(creator: string, kind: string, after?: string): Promise<{ items: T[]; next?: string }>;
}

export interface PhotographyPackage {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceLabel: string;
}

export interface PhotographySlot {
  id: string;
  packageId: string;
  startsAt: string;
  endsAt: string;
  location: string;
}

export interface PhotographyBooking {
  id: string;
  slotId: string;
  email: string;
  name: string;
  notes: string;
  status: 'requested' | 'confirmed' | 'cancelled';
  createdAt: string;
}

export interface PhotographyGallery {
  id: string;
  title: string;
  emails: string[];
  assetIds: string[];
  assetWorkIds?: Record<string, string>;
  downloads: boolean;
  active: boolean;
  expiresAt?: string;
}

export interface PhotographyChallenge {
  id: string;
  email: string;
  scope: string;
  digest: string;
  expires: number;
  attempts: number;
  eligible: boolean;
}

export interface PhotographyClientSession {
  digest: string;
  email: string;
  scope: string;
  expires: number;
}

export interface PhotographyState {
  revision: number;
  enabled: boolean;
  timezone: string;
  packages: PhotographyPackage[];
  slots: PhotographySlot[];
  bookings: PhotographyBooking[];
  galleries: PhotographyGallery[];
  challenges: PhotographyChallenge[];
  sessions: PhotographyClientSession[];
  requests: { emailHash: string; ipHash: string; at: number }[];
}

export interface PhotographyRepository {
  get(creatorId: string): Promise<PhotographyState | undefined>;
  save(creatorId: string, state: PhotographyState, expected: number): Promise<void>;
}
