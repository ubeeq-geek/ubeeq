export const EXTENSION_API_VERSION = "1" as const;
export type ExtensionApiVersion = typeof EXTENSION_API_VERSION;

export const EXTENSION_CONTRACTS = [
  "brand",
  "moderation-policy",
  "billing-provider",
  "discovery",
  "integration-provider",
  "federation-policy",
  "operations"
] as const;
export type ExtensionContract = (typeof EXTENSION_CONTRACTS)[number];

export const HOST_EXTENSION_PORTS = [
  "tenancy-and-access",
  "publication-admission",
  "watermark-and-transform",
  "usage-quota",
  "connector-app-credentials",
  "studio-ui-slots"
] as const;
export type HostExtensionPortName = (typeof HOST_EXTENSION_PORTS)[number];

export const INTEGRATION_CAPABILITIES = [
  "import.metadata",
  "import.media",
  "publish.work",
  "publish.announcement",
  "sync.comments",
  "sync.activity",
  "delete.remote"
] as const;
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number];

export interface ExtensionManifest {
  id: string;
  apiVersion: ExtensionApiVersion;
  contracts: readonly ExtensionContract[];
}

export interface BrandExtension {
  id: string;
  apiVersion: ExtensionApiVersion;
  displayName: string;
  theme: Record<string, string>;
  navigation: readonly { id: string; label: string; href: string }[];
}

export interface ModerationEvaluationInput {
  assetId: string;
  evidence: readonly { type: string; value: unknown }[];
}

export interface ModerationDecision {
  status: "allow" | "hold" | "block";
  visibility: "public" | "private" | "removed";
  exportAllowed: boolean;
  reviewReason?: string;
  requiredActions?: readonly string[];
}

export interface ModerationPolicy {
  id: string;
  apiVersion: ExtensionApiVersion;
  evaluate(input: ModerationEvaluationInput): Promise<ModerationDecision>;
}

export interface BillingProvider {
  id: string;
  apiVersion: ExtensionApiVersion;
  recordUsage(input: { accountId: string; meter: string; quantity: number }): Promise<void>;
}

export interface DiscoveryExtension {
  id: string;
  apiVersion: ExtensionApiVersion;
  isEligible(input: { workId: string }): Promise<boolean>;
}

export interface IntegrationProvider {
  id: string;
  apiVersion: ExtensionApiVersion;
  isEnabled(input: { integrationId: string; accountId: string }): Promise<boolean>;
}

export interface IntegrationConnectorManifest {
  id: string;
  apiVersion: ExtensionApiVersion;
  capabilities: readonly IntegrationCapability[];
}

export interface FederationPolicy {
  id: string;
  apiVersion: ExtensionApiVersion;
  evaluateRemote(input: { actorId: string; host: string }): Promise<"allow" | "warn" | "deny">;
}

export interface OperationsExtension {
  id: string;
  apiVersion: ExtensionApiVersion;
  reportHealth(): Promise<{ status: "ok" | "degraded" | "failed" }>;
}

export type CreatorAccessRole = "owner" | "admin" | "editor" | "analyst";
export type PrincipalAccountScope = "creator_operator" | "customer_account";

export class SingleOperatorLimitError extends Error {
  readonly code = "SINGLE_OPERATOR_INSTANCE_LIMIT" as const;
  readonly statusCode = 403 as const;

  constructor(message = "Self-hosted Ubeeq instances allow one Creator operator user. Additional Creator Identities and customer accounts remain supported.") {
    super(message);
    this.name = "SingleOperatorLimitError";
  }
}

export class FeatureDisabledInSingleOperatorModeError extends Error {
  readonly code = "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE" as const;
  readonly statusCode = 403 as const;

  constructor(feature: string) {
    super(`${feature} is disabled in single-operator Ubeeq mode.`);
    this.name = "FeatureDisabledInSingleOperatorModeError";
  }
}

export interface TenancyAndAccessPort {
  readonly mode: "single_operator" | "multi_tenant_saas";
  assertCanCreateCreatorUser(context: { existingCreatorUserCount: number; actorUserId?: string }): Promise<void>;
  assertCanCreateCustomerAccount?(context: { email: string }): Promise<void>;
  listAccessibleCreatorIds(actorUserId: string): Promise<string[]>;
  resolveCreatorRole(actorUserId: string, creatorId: string): Promise<CreatorAccessRole | null>;
  isContributorManagementEnabled(): boolean;
  isOrganizationManagementEnabled(): boolean;
}

export interface PublicationAdmissionEvaluationInput {
  /** Persisted revision and authenticated publisher supplied by the core host. */
  workRevision?: number;
  actorUserId?: string;
  workId: string;
  creatorId: string;
  destination: string;
  visibility: string;
  mediaSignals?: Record<string, unknown>;
  textSignals?: Record<string, unknown>;
}

export interface PublicationAdmissionResult {
  allowed: boolean;
  state: "eligible" | "pending_review" | "restricted" | "rejected";
  reasonCodes: string[];
  userMessage?: string;
}

export interface PublicationAdmissionPort {
  evaluatePublication(input: PublicationAdmissionEvaluationInput): Promise<PublicationAdmissionResult>;
}

export interface TextWatermarkSpec {
  text: string;
  opacity?: number;
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left" | "center" | "tiled";
}

export interface GraphicWatermarkSpec {
  assetId: string;
  opacity?: number;
  scale?: number;
  marginPercent?: number;
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left" | "center" | "tiled";
}

export interface ImageAdjustmentSpec {
  brightness?: number;
  contrast?: number;
  autoLuminance?: boolean;
}

export interface DerivativeTransformInput {
  sourceBytes: Uint8Array;
  mimeType: string;
  creatorId: string;
  textWatermark?: TextWatermarkSpec;
  graphicWatermark?: GraphicWatermarkSpec;
  graphicWatermarkAssetId?: string;
  adjustments?: ImageAdjustmentSpec;
}

export interface DerivativeTransformOutput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface WatermarkAndTransformPort {
  readonly supportsGraphicWatermark: boolean;
  readonly supportsImageAdjustments: boolean;
  applyDerivativeTransform(input: DerivativeTransformInput): Promise<DerivativeTransformOutput>;
}

export interface UsageQuotaReservationInput {
  idempotencyKey?: string;
  reservationId?: string;
  creatorId: string;
  storageBytesDelta?: number;
  deliveryBytesDelta?: number;
  processingCreditsDelta?: number;
  operation: string;
}

export interface UsageQuotaReservationResult {
  reservationId?: string;
  allowed: boolean;
  reasonCode?: string;
  remainingCredits?: number;
}

export interface UsageSettlementInput {
  /** Trusted time of the measured effect, preserved across settlement delivery retries. */
  observedAt?: string;
  creatorId: string;
  operation: string;
  processingCreditsUsed?: number;
  storageBytesDelta?: number;
  deliveryBytesDelta?: number;
  idempotencyKey: string;
}

export interface UsageQuotaPort {
  checkAndReserveQuota(input: UsageQuotaReservationInput): Promise<UsageQuotaReservationResult>;
  /** Recheck current execution eligibility separately from an idempotent reservation receipt.
   * Recovery must still settle old reservations when new execution is no longer allowed. */
  checkCurrentAdmission?(input: Pick<UsageSettlementInput, 'creatorId' | 'operation' | 'idempotencyKey'>): Promise<UsageQuotaReservationResult>;
  recordUsageSettlement(input: UsageSettlementInput): Promise<void>;
}

export type ConnectorCredentialSource = "operator_env" | "creator_secret" | "platform_managed";

export interface ResolvedOAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webhookVerifyToken?: string;
  credentialSource: ConnectorCredentialSource;
}

export interface ConnectorAppCredentialsPort {
  readonly mode: "byo_credentials" | "platform_managed";
  resolveOAuthClient(provider: string, creatorId: string): Promise<ResolvedOAuthClientCredentials | null>;
}

export interface StudioUiExtensionSlots {
  workDetailActionsSlot?: string;
  assetToolbarSlot?: string;
  creatorSettingsTabsSlot?: string;
  accountBillingPanelSlot?: string;
  publishingPreFlightBannerSlot?: string;
  supportDrawerSlot?: string;
}

export interface HostExtensionRuntimePorts {
  tenancyAndAccess: TenancyAndAccessPort;
  publicationAdmission: PublicationAdmissionPort;
  watermarkAndTransform: WatermarkAndTransformPort;
  usageQuota: UsageQuotaPort;
  connectorAppCredentials: ConnectorAppCredentialsPort;
  studioUiSlots: StudioUiExtensionSlots;
}

export const EMPTY_STUDIO_UI_EXTENSION_SLOTS: Readonly<StudioUiExtensionSlots> = Object.freeze({});

export const createSingleOperatorTenancyPort = (options?: {
  getOperatorUserId?: () => Promise<string | null> | string | null;
  listOperatorCreatorIds?: (operatorUserId: string) => Promise<string[]> | string[];
}): TenancyAndAccessPort => ({
  mode: "single_operator",
  async assertCanCreateCreatorUser({ existingCreatorUserCount, actorUserId }) {
    const operatorId = await options?.getOperatorUserId?.();
    if (operatorId && actorUserId && actorUserId === operatorId) return;
    if (operatorId && actorUserId && actorUserId !== operatorId) throw new SingleOperatorLimitError();
    if (existingCreatorUserCount >= 1) {
      throw new SingleOperatorLimitError();
    }
  },
  async assertCanCreateCustomerAccount() {
    // Unlimited buyer, subscriber, mailing-list, and client accounts are permitted.
  },
  async listAccessibleCreatorIds(actorUserId) {
    const operatorId = await options?.getOperatorUserId?.();
    if (operatorId && operatorId !== actorUserId) return [];
    const ids = await options?.listOperatorCreatorIds?.(actorUserId);
    return ids ? [...ids] : [];
  },
  async resolveCreatorRole(actorUserId, creatorId) {
    const ids = await this.listAccessibleCreatorIds(actorUserId);
    return ids.includes(creatorId) ? "owner" : null;
  },
  isContributorManagementEnabled() {
    return false;
  },
  isOrganizationManagementEnabled() {
    return false;
  }
});

export const createOpenPublicationAdmissionPort = (): PublicationAdmissionPort => ({
  async evaluatePublication() {
    return {
      allowed: true,
      state: "eligible",
      reasonCodes: []
    };
  }
});

export const createPassThroughWatermarkPort = (options?: {
  renderTextWatermark?: (input: {
    sourceBytes: Uint8Array;
    mimeType: string;
    watermark: TextWatermarkSpec;
  }) => Promise<DerivativeTransformOutput>;
}): WatermarkAndTransformPort => ({
  supportsGraphicWatermark: false,
  supportsImageAdjustments: false,
  async applyDerivativeTransform(input) {
    if (input.graphicWatermark || input.graphicWatermarkAssetId) {
      throw new FeatureDisabledInSingleOperatorModeError("Custom graphic watermarking");
    }
    if (input.adjustments && (input.adjustments.brightness !== undefined || input.adjustments.contrast !== undefined || input.adjustments.autoLuminance)) {
      throw new FeatureDisabledInSingleOperatorModeError("Pro image adjustments");
    }
    if (input.textWatermark && options?.renderTextWatermark) {
      return options.renderTextWatermark({
        sourceBytes: input.sourceBytes,
        mimeType: input.mimeType,
        watermark: input.textWatermark
      });
    }
    return { bytes: input.sourceBytes, mimeType: input.mimeType };
  }
});

export const createUnmeteredUsageQuotaPort = (): UsageQuotaPort => ({
  async checkAndReserveQuota() {
    return { allowed: true };
  },
  async recordUsageSettlement() {
    // Self-hosted open-core instances do not meter SaaS platform plans or credits.
  }
});

export const createByoConnectorCredentialsPort = (options?: {
  env?: Record<string, string | undefined>;
  lookupCreatorSecret?: (provider: string, creatorId: string) => Promise<Omit<ResolvedOAuthClientCredentials, "credentialSource"> | null>;
  defaultRedirectUriForProvider?: (provider: string) => string | undefined;
}): ConnectorAppCredentialsPort => ({
  mode: "byo_credentials",
  async resolveOAuthClient(provider, creatorId) {
    const creatorSecret = await options?.lookupCreatorSecret?.(provider, creatorId);
    if (creatorSecret) {
      return { ...creatorSecret, credentialSource: "creator_secret" };
    }
    const env = options?.env ?? {};
    const normalized = provider.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const clientId = env[`UBEEQ_${normalized}_CLIENT_ID`];
    const clientSecret = env[`UBEEQ_${normalized}_CLIENT_SECRET`];
    const redirectUri = env[`UBEEQ_${normalized}_REDIRECT_URI`] ?? options?.defaultRedirectUriForProvider?.(provider);
    if (!clientId || !clientSecret || !redirectUri) {
      return null;
    }
    return {
      clientId,
      clientSecret,
      redirectUri,
      webhookVerifyToken: env[`UBEEQ_${normalized}_WEBHOOK_VERIFY_TOKEN`],
      credentialSource: "operator_env"
    };
  }
});

export const createDefaultOpenCorePorts = (overrides?: Partial<HostExtensionRuntimePorts>): HostExtensionRuntimePorts => ({
  tenancyAndAccess: overrides?.tenancyAndAccess ?? createSingleOperatorTenancyPort(),
  publicationAdmission: overrides?.publicationAdmission ?? createOpenPublicationAdmissionPort(),
  watermarkAndTransform: overrides?.watermarkAndTransform ?? createPassThroughWatermarkPort(),
  usageQuota: overrides?.usageQuota ?? createUnmeteredUsageQuotaPort(),
  connectorAppCredentials: overrides?.connectorAppCredentials ?? createByoConnectorCredentialsPort(),
  studioUiSlots: overrides?.studioUiSlots ?? EMPTY_STUDIO_UI_EXTENSION_SLOTS
});

export const validateExtensionManifest = (
  manifest: ExtensionManifest,
  requiredContracts: readonly ExtensionContract[]
): void => {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(manifest.id)) throw new Error(`Extension id ${manifest.id} is invalid`);
  if (manifest.apiVersion !== EXTENSION_API_VERSION) throw new Error(`Extension ${manifest.id} requires unsupported API version ${manifest.apiVersion}`);
  if (new Set(manifest.contracts).size !== manifest.contracts.length) throw new Error(`Extension ${manifest.id} declares duplicate contracts`);
  for (const contract of requiredContracts) {
    if (!manifest.contracts.includes(contract)) throw new Error(`Extension ${manifest.id} does not implement required contract ${contract}`);
  }
};

export const validateIntegrationConnectorManifest = (manifest: IntegrationConnectorManifest): void => {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(manifest.id)) throw new Error(`Integration connector id ${manifest.id} is invalid`);
  if (manifest.apiVersion !== EXTENSION_API_VERSION) throw new Error(`Integration connector ${manifest.id} requires unsupported API version ${manifest.apiVersion}`);
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) throw new Error(`Integration connector ${manifest.id} declares duplicate capabilities`);
};

/** A host tenancy rule denied creator onboarding; callers may display the host's actionable reason. */
export class TenancyAdmissionError extends Error {
  constructor(readonly reasonCode: string, message: string) { super(message); this.name = 'TenancyAdmissionError'; }
}
