import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ConnectorAppMode } from './connector-credentials.js';

export const INSTAGRAM_PLATFORM = 'instagram' as const;
export const INSTAGRAM_POLICY_PROFILE = 'instagram_public_safe' as const;
export const INSTAGRAM_POLICY_VERSION = '2026-08-23.1';

export type InstagramPlacement = 'IMAGE' | 'CAROUSEL' | 'REEL' | 'STORY';
export type InstagramConnectionState =
  | 'PENDING_OAUTH' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'UNSUPPORTED_ACCOUNT_TYPE'
  | 'APP_REVIEW_REQUIRED' | 'INSUFFICIENT_SCOPE' | 'CAPABILITY_RESTRICTED'
  | 'RATE_LIMITED' | 'WEBHOOK_DEGRADED' | 'DISCONNECTED' | 'ERROR';
export type InstagramEligibilityResult =
  | 'ALLOWED_MANAGED' | 'CREATOR_OWNED_REQUIRED' | 'PLATFORM_INELIGIBLE'
  | 'DESTINATION_POLICY_DENIED' | 'SAFETY_HOLD';

export interface InstagramCapabilities {
  accountRead: boolean;
  mediaRead: boolean;
  imagePublish: boolean;
  carouselPublish: boolean;
  reelPublish: boolean;
  storyPublish: boolean;
  mediaUpdate: boolean;
  mediaDeleteOrArchive: boolean;
  insightsRead: boolean;
  commentsRead: boolean;
  commentsReply: boolean;
}

export interface InstagramConnection {
  connectionId: string;
  ownerUserId: string;
  creatorId: string;
  mode: ConnectorAppMode;
  remoteProfessionalAccountId: string;
  accountType: 'BUSINESS' | 'CREATOR';
  encryptedCredentialReference: string;
  scopes: string[];
  capabilities: InstagramCapabilities;
  apiVersion: string;
  policyProfileVersion: string;
  state: InstagramConnectionState;
  lastSyncAt?: string;
}

export interface InstagramPreflightInput {
  connection: InstagramConnection;
  placement: InstagramPlacement;
  media: Array<{ derivativeId: string; contentType: string; byteSize: number; width: number; height: number; durationSeconds?: number }>;
  caption: string;
  contentRating: 'general' | 'suggestive' | 'mature' | 'sexual' | 'fetish' | 'graphic';
  rightsAttested: boolean;
  creatorAttested: boolean;
  safetyHold?: boolean;
  adultContent?: boolean;
  publishingLimitAvailable?: boolean;
}

export interface InstagramEligibilityDecision {
  result: InstagramEligibilityResult;
  reasonCode: string;
  explanation: string;
  policyProfile: typeof INSTAGRAM_POLICY_PROFILE;
  policyVersion: string;
}

export type InstagramContainerStatus = 'DRAFT' | 'QUEUED' | 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'UNKNOWN';

export interface InstagramPublication {
  publicationId: string;
  workId: string;
  connectionId: string;
  placement: InstagramPlacement;
  derivativeIds: string[];
  captionSnapshot: string;
  accessibilitySnapshot?: string;
  providerVersion: string;
  idempotencyKey: string;
  status: 'DRAFT' | 'PREFLIGHT_PASSED' | 'CONFIRMED' | 'CONTAINER_PROCESSING' | 'READY' | 'PUBLISHED' | 'UNKNOWN' | 'FAILED' | 'REMOTE_MISSING' | 'CANCELLED';
  containerIds: string[];
  remoteMediaId?: string;
  remoteUrl?: string;
  publishedAt?: string;
}

export interface InstagramDeliveryCapability {
  pathToken: string;
  derivativeId: string;
  deliverySlot: number;
  expiresAt: string;
}

export interface InstagramMediaConstraints {
  imageMimeTypes: string[];
  videoMimeTypes: string[];
  maximumImageBytes: number;
  maximumVideoBytes: number;
  maximumReelDurationSeconds: number;
  maximumStoryDurationSeconds: number;
  minimumAspectRatio: number;
  maximumAspectRatio: number;
  maximumCarouselItems: number;
  maximumCaptionCharacters: number;
}

export interface InstagramValidationIssue { field: string; code: string; message: string }

export const instagramPublishingLimitAvailable = (payload: Record<string, unknown>): boolean | undefined => {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const first = data[0] && typeof data[0] === 'object' ? (data[0] as Record<string, unknown>) : payload;
  const usage = Number(first.quota_usage);
  const config = first.config && typeof first.config === 'object' ? (first.config as Record<string, unknown>) : {};
  const total = Number(config.quota_total);
  return Number.isFinite(usage) && Number.isFinite(total) && total >= 0 ? usage < total : undefined;
};

export const validateInstagramMedia = (input: InstagramPreflightInput, constraints: InstagramMediaConstraints): InstagramValidationIssue[] => {
  const issues: InstagramValidationIssue[] = [];
  if (!input.media.length) issues.push({ field: 'media', code: 'MEDIA_REQUIRED', message: 'Select at least one approved derivative.' });
  if (input.placement === 'IMAGE' && input.media.length !== 1) issues.push({ field: 'media', code: 'IMAGE_COUNT_INVALID', message: 'An image publication requires exactly one derivative.' });
  if (input.placement === 'CAROUSEL' && (input.media.length < 2 || input.media.length > constraints.maximumCarouselItems)) issues.push({ field: 'media', code: 'CAROUSEL_COUNT_INVALID', message: `A carousel requires 2–${constraints.maximumCarouselItems} derivatives.` });
  if ((input.placement === 'REEL' || input.placement === 'STORY') && input.media.length !== 1) issues.push({ field: 'media', code: 'PLACEMENT_COUNT_INVALID', message: 'This placement requires exactly one derivative.' });
  if (input.caption.length > constraints.maximumCaptionCharacters) issues.push({ field: 'caption', code: 'CAPTION_TOO_LONG', message: `Caption must not exceed ${constraints.maximumCaptionCharacters} characters.` });
  input.media.forEach((media, index) => {
    const field = `media.${index}`;
    const requiresVideo = input.placement === 'REEL';
    const permitsVideo = requiresVideo || input.placement === 'STORY';
    const isVideo = constraints.videoMimeTypes.includes(media.contentType);
    const supported = requiresVideo ? isVideo : constraints.imageMimeTypes.includes(media.contentType) || (permitsVideo && isVideo);
    if (!supported) issues.push({ field, code: 'MEDIA_TYPE_UNSUPPORTED', message: `${media.contentType} is not supported for this placement.` });
    if (media.byteSize > (isVideo ? constraints.maximumVideoBytes : constraints.maximumImageBytes)) issues.push({ field, code: 'MEDIA_TOO_LARGE', message: 'The selected derivative exceeds the current provider byte limit.' });
    const durationLimit = input.placement === 'REEL' ? constraints.maximumReelDurationSeconds : input.placement === 'STORY' ? constraints.maximumStoryDurationSeconds : undefined;
    if (isVideo && (media.durationSeconds === undefined || (durationLimit !== undefined && media.durationSeconds > durationLimit))) issues.push({ field, code: 'DURATION_UNSUPPORTED', message: 'Trim this derivative to the current placement duration limit.' });
    const ratio = media.height > 0 ? media.width / media.height : 0;
    if (ratio < constraints.minimumAspectRatio || ratio > constraints.maximumAspectRatio) issues.push({ field, code: 'ASPECT_RATIO_UNSUPPORTED', message: 'Crop this derivative to a supported aspect ratio.' });
  });
  return issues;
};

const placementCapability: Record<InstagramPlacement, keyof InstagramCapabilities> = {
  IMAGE: 'imagePublish', CAROUSEL: 'carouselPublish', REEL: 'reelPublish', STORY: 'storyPublish'
};

export const evaluateInstagramEligibility = (input: InstagramPreflightInput): InstagramEligibilityDecision => {
  const decision = (result: InstagramEligibilityResult, reasonCode: string, explanation: string): InstagramEligibilityDecision => ({
    result, reasonCode, explanation, policyProfile: INSTAGRAM_POLICY_PROFILE, policyVersion: input.connection.policyProfileVersion || INSTAGRAM_POLICY_VERSION
  });
  if (input.safetyHold) return decision('SAFETY_HOLD', 'ACTIVE_SAFETY_HOLD', 'A safety or legal hold pauses new external publication.');
  if (input.connection.state !== 'CONNECTED') return decision('PLATFORM_INELIGIBLE', `CONNECTION_${input.connection.state}`, 'The Instagram connection is not ready for publishing.');
  if (!input.connection.capabilities[placementCapability[input.placement]]) return decision('PLATFORM_INELIGIBLE', 'PLACEMENT_UNSUPPORTED', 'The connected account and approved API version do not support this placement.');
  if (input.publishingLimitAvailable === false) return decision('PLATFORM_INELIGIBLE', 'PUBLISHING_LIMIT_REACHED', 'The provider publishing limit currently has no capacity.');
  if (input.adultContent || ['mature', 'sexual', 'fetish', 'graphic'].includes(input.contentRating)) {
    return decision('DESTINATION_POLICY_DENIED', 'PUBLIC_SAFE_PROFILE_DENIED', 'This output is excluded by the conservative Instagram public-safe policy.');
  }
  if (!input.rightsAttested) return decision('DESTINATION_POLICY_DENIED', 'RIGHTS_ATTESTATION_REQUIRED', 'Publishing rights must be attested before delivery.');
  if (!input.creatorAttested) return decision('DESTINATION_POLICY_DENIED', 'CREATOR_ATTESTATION_REQUIRED', 'The creator must approve the exact preview derivative.');
  return decision('ALLOWED_MANAGED', 'PREFLIGHT_ALLOWED', 'The managed connection may proceed to provider-format validation and final confirmation.');
};

export const instagramIdempotencyKey = (workId: string, accountId: string, placement: InstagramPlacement, intentVersion: number, secret: string): string => {
  if (!secret) throw new Error('Instagram idempotency secret is required');
  return createHmac('sha256', secret)
    .update(JSON.stringify([workId, accountId, placement, intentVersion])).digest('hex');
};

export const verifyInstagramWebhookSignature = (rawBody: Buffer, signature: string | undefined, appSecret: string): boolean => {
  if (!signature?.startsWith('sha256=') || !appSecret) return false;
  const received = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
};

export const issueInstagramDeliveryCapability = (
  derivativeId: string,
  publicationId: string,
  deliverySlot: number,
  secret: string,
  ttlSeconds: number,
  now = Date.now()
): InstagramDeliveryCapability => {
  if (!secret || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error('Instagram delivery capability configuration is invalid');
  const expiresAtMs = now + ttlSeconds * 1000;
  const nonce = randomBytes(24).toString('base64url');
  if (!Number.isSafeInteger(deliverySlot) || deliverySlot < 0) throw new Error('Instagram delivery slot is invalid');
  const payload = `${publicationId}.${deliverySlot}.${expiresAtMs}.${nonce}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return { pathToken: Buffer.from(`${payload}.${signature}`).toString('base64url'), derivativeId, deliverySlot, expiresAt: new Date(expiresAtMs).toISOString() };
};

export const verifyInstagramDeliveryCapability = (
  pathToken: string,
  publicationId: string,
  deliverySlot: number,
  secret: string,
  now = Date.now()
): boolean => {
  let decoded: string;
  try { decoded = Buffer.from(pathToken, 'base64url').toString('utf8'); } catch { return false; }
  const parts = decoded.split('.');
  if (parts.length !== 5 || parts[0] !== publicationId || Number(parts[1]) !== deliverySlot) return false;
  const expiresAt = Number(parts[2]);
  if (!Number.isSafeInteger(expiresAt) || now >= expiresAt) return false;
  const payload = parts.slice(0, 4).join('.');
  const received = Buffer.from(parts[4], 'base64url');
  const expected = createHmac('sha256', secret).update(payload).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
};
