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
