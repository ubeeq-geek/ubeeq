export type FanvueConnectionMode = 'STUDIO_MANAGED' | 'CREATOR_OWNED';
export type FanvueConnectionState =
  | 'PENDING_OAUTH' | 'CONNECTED' | 'REAUTH_REQUIRED' | 'INSUFFICIENT_SCOPE'
  | 'FANVUE_RESTRICTED' | 'DISCONNECTED' | 'ERROR';

export interface FanvueConnection {
  connectionId: string;
  ownerId: string;
  ownerType: 'creator' | 'studio';
  mode: FanvueConnectionMode;
  fanvueUserUuid?: string;
  scopes: string[];
  capabilities: Array<'read_posts' | 'publish_posts' | 'manage_mapped_posts' | 'account_health'>;
  state: FanvueConnectionState;
  apiVersion: string;
  verificationStatus: 'unknown' | 'verified' | 'restricted';
  createdAt: string;
  updatedAt: string;
}

export interface FanvueRightsEligibilityInput {
  rightsManifestReference?: string;
  ownershipAttested: boolean;
  everyParticipantAdultAttested: boolean;
  consentAttested: boolean;
  aiGenerated: boolean;
  aiDisclosureConfirmed: boolean;
  realPersonLikenessCleared: boolean;
  activeSafetyHold: boolean;
  platformPolicy: 'ELIGIBLE' | 'CREATOR_OWNED_REQUIRED' | 'PLATFORM_INELIGIBLE';
  connectionMode: FanvueConnectionMode;
  mediaSupported: boolean;
}

export interface FanvueEligibilityResult {
  eligible: boolean;
  reasons: string[];
}

export const evaluateFanvueRightsEligibility = (input: FanvueRightsEligibilityInput): FanvueEligibilityResult => {
  const reasons: string[] = [];
  if (input.activeSafetyHold) reasons.push('ACTIVE_SAFETY_HOLD');
  if (!input.ownershipAttested) reasons.push('OWNERSHIP_ATTESTATION_REQUIRED');
  if (!input.everyParticipantAdultAttested) reasons.push('ADULT_ATTESTATION_REQUIRED');
  if (!input.consentAttested) reasons.push('CONSENT_ATTESTATION_REQUIRED');
  if (input.aiGenerated && !input.aiDisclosureConfirmed) reasons.push('AI_DISCLOSURE_REQUIRED');
  if (!input.realPersonLikenessCleared) reasons.push('LIKENESS_CLEARANCE_REQUIRED');
  if (input.platformPolicy === 'PLATFORM_INELIGIBLE') reasons.push('PLATFORM_POLICY_EXCLUDED');
  if (input.platformPolicy === 'CREATOR_OWNED_REQUIRED' && input.connectionMode !== 'CREATOR_OWNED') {
    reasons.push('CREATOR_OWNED_CONNECTION_REQUIRED');
  }
  if (!input.mediaSupported) reasons.push('MEDIA_FORMAT_UNSUPPORTED');

  return {
    eligible: reasons.length === 0,
    reasons,
  };
};
