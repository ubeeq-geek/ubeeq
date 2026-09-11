/** Caller-owned capability facts; no provider catalogue or product eligibility lives here. */
export interface IntegrationPublicationPolicy {
  label: string;
  announce: boolean;
  publish: Readonly<Partial<Record<string, boolean>>>;
  aiLabel: { carouselPrecision: "per-item" | "whole-carousel" | "none" };
  limits: {
    rollout?: { state: string };
    media?: {
      maximumItems?: number;
      maximumCaptionCharacters?: number;
      allowedMimeTypes?: readonly string[];
      maximumBytes?: number;
    };
    access?: {
      requiresRightsAttestation?: boolean;
      requiresAdultAttestation?: boolean;
      requiresConsentAttestation?: boolean;
    };
  };
}

export type IntegrationPreflightIntent = 'publish' | 'announce';
export type IntegrationPreflightSeverity = 'blocking' | 'warning';

export interface IntegrationPreflightInput {
  platform: string;
  intent?: IntegrationPreflightIntent;
  mediaTypes?: readonly string[];
  aiDisclosures?: readonly string[];
  /**
   * Number of assets in one remote publication (for example, carousel
   * children). A selection of independent Works must not be passed here:
   * bulk publishing creates one remote publication per Work.
   */
  itemCount?: number;
  caption?: string;
  mimeTypes?: readonly string[];
  bytes?: number;
  /** Durable facts checked immediately before a remote operation is admitted. */
  admission?: IntegrationPreflightAdmission;
}

export interface IntegrationPreflightAdmission {
  connectionState?: 'connected' | 'authentication_required' | 'rate_limited' | 'temporarily_unavailable' | 'disabled' | 'attention';
  requiredScopes?: readonly string[];
  grantedScopes?: readonly string[];
  policyBlocked?: boolean;
  rightsAttested?: boolean;
  adultAttested?: boolean;
  consentAttested?: boolean;
}

export interface IntegrationPreflightIssue {
  code:
    | 'unsupported_operation'
    | 'unsupported_media'
    | 'configuration_required'
    | 'mixed_ai_carousel'
    | 'maximum_items_exceeded'
    | 'caption_too_long'
    | 'unsupported_mime_type'
    | 'asset_too_large'
    | 'account_not_ready'
    | 'missing_scope'
    | 'policy_blocked'
    | 'rights_attestation_required'
    | 'adult_attestation_required'
    | 'consent_attestation_required';
  severity: IntegrationPreflightSeverity;
  message: string;
}

export interface IntegrationPreflightResult {
  platform: string;
  intent: IntegrationPreflightIntent;
  issues: IntegrationPreflightIssue[];
  ok: boolean;
  static: { issues: IntegrationPreflightIssue[]; ok: boolean };
  admission: { checked: boolean; issues: IntegrationPreflightIssue[]; ok: boolean };
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

const supportsMimeType = (allowed: readonly string[], mimeType: string): boolean =>
  allowed.some((pattern) => pattern === mimeType || (pattern.endsWith('/*') && mimeType.startsWith(pattern.slice(0, -1))));

/**
 * Destination-neutral validation for the Review & publish flow.
 *
 * This deliberately validates only facts that are known before a job is
 * queued. Provider API calls, account health, and permission checks still run
 * in the durable external-job worker immediately before delivery.
 */
export const preflightIntegrationPublication = (
  input: IntegrationPreflightInput,
  capability: IntegrationPublicationPolicy
): IntegrationPreflightResult => {
  const intent = input.intent ?? 'publish';
  const issues: IntegrationPreflightIssue[] = [];
  const mediaTypes = unique(input.mediaTypes ?? []);

  if (capability.limits.rollout?.state === 'configuration_required') {
    issues.push({
      code: 'configuration_required',
      severity: 'blocking',
      message: `${capability.label} has not been configured for this deployment.`
    });
  }

  if (intent === 'announce' ? !capability.announce : mediaTypes.some((type) => !capability.publish[type])) {
    issues.push({
      code: 'unsupported_operation',
      severity: 'blocking',
      message: intent === 'announce'
        ? `${capability.label} cannot announce this publication.`
        : `${capability.label} cannot publish one or more selected Work types.`
    });
  }

  for (const mediaType of mediaTypes) {
    if (intent === 'publish' && !capability.publish[mediaType]) {
      issues.push({
        code: 'unsupported_media',
        severity: 'blocking',
        message: `${capability.label} does not support publishing ${mediaType} Works.`
      });
    }
  }

  if (
    mediaTypes.includes('carousel') &&
    capability.aiLabel.carouselPrecision === 'whole-carousel' &&
    unique(input.aiDisclosures ?? []).length > 1
  ) {
    issues.push({
      code: 'mixed_ai_carousel',
      severity: 'warning',
      message: `${capability.label} can disclose AI provenance only for the whole carousel. Its parent publication will use one disclosure for mixed assets.`
    });
  }

  const mediaLimits = capability.limits.media;
  if (mediaLimits?.maximumItems !== undefined && input.itemCount !== undefined && input.itemCount > mediaLimits.maximumItems) {
    issues.push({
      code: 'maximum_items_exceeded',
      severity: 'blocking',
      message: `${capability.label} allows at most ${mediaLimits.maximumItems} items in this publication.`
    });
  }
  if (
    mediaLimits?.maximumCaptionCharacters !== undefined &&
    input.caption !== undefined &&
    input.caption.length > mediaLimits.maximumCaptionCharacters
  ) {
    issues.push({
      code: 'caption_too_long',
      severity: 'blocking',
      message: `${capability.label} captions are limited to ${mediaLimits.maximumCaptionCharacters.toLocaleString()} characters.`
    });
  }
  if (
    mediaLimits?.allowedMimeTypes?.length &&
    input.mimeTypes?.some((mimeType) => !supportsMimeType(mediaLimits.allowedMimeTypes!, mimeType))
  ) {
    issues.push({
      code: 'unsupported_mime_type',
      severity: 'blocking',
      message: `${capability.label} does not support one or more selected media file types.`
    });
  }
  if (mediaLimits?.maximumBytes !== undefined && input.bytes !== undefined && input.bytes > mediaLimits.maximumBytes) {
    issues.push({
      code: 'asset_too_large',
      severity: 'blocking',
      message: `${capability.label} supports files up to ${Math.round(mediaLimits.maximumBytes / 1024 / 1024)} MB.`
    });
  }

  const staticIssues = [...issues];
  const admissionIssues: IntegrationPreflightIssue[] = [];
  const admission = input.admission;
  if (admission) {
    if (admission.connectionState && admission.connectionState !== 'connected') {
      admissionIssues.push({
        code: 'account_not_ready', severity: 'blocking',
        message: admission.connectionState === 'authentication_required'
          ? `Reconnect ${capability.label} before publishing.`
          : admission.connectionState === 'rate_limited'
            ? `${capability.label} is rate limited; wait before retrying.`
            : `${capability.label} is not ready for publishing. Review its connection.`
      });
    }
    const grantedScopes = new Set(admission.grantedScopes || []);
    const missingScopes = (admission.requiredScopes || []).filter((scope) => !grantedScopes.has(scope));
    if (missingScopes.length) admissionIssues.push({
      code: 'missing_scope', severity: 'blocking',
      message: `${capability.label} needs additional permission before publishing.`
    });
    if (admission.policyBlocked) admissionIssues.push({
      code: 'policy_blocked', severity: 'blocking',
      message: 'This integration action is blocked by an active safety hold.'
    });
    const access = capability.limits.access;
    if (access?.requiresRightsAttestation && !admission.rightsAttested) admissionIssues.push({ code: 'rights_attestation_required', severity: 'blocking', message: `${capability.label} requires a rights attestation before publishing.` });
    if (access?.requiresAdultAttestation && !admission.adultAttested) admissionIssues.push({ code: 'adult_attestation_required', severity: 'blocking', message: `${capability.label} requires an adult-participant attestation before publishing.` });
    if (access?.requiresConsentAttestation && !admission.consentAttested) admissionIssues.push({ code: 'consent_attestation_required', severity: 'blocking', message: `${capability.label} requires a consent attestation before publishing.` });
  }
  const allIssues = [...staticIssues, ...admissionIssues];
  return {
    platform: input.platform,
    intent,
    issues: allIssues,
    ok: !allIssues.some((issue) => issue.severity === 'blocking'),
    static: { issues: staticIssues, ok: !staticIssues.some((issue) => issue.severity === 'blocking') },
    admission: { checked: Boolean(admission), issues: admissionIssues, ok: !admissionIssues.some((issue) => issue.severity === 'blocking') }
  };
};
