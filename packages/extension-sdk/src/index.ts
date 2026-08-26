export const EXTENSION_API_VERSION = "1" as const;
export type ExtensionApiVersion = typeof EXTENSION_API_VERSION;

export type ExtensionContract =
  | "brand"
  | "moderation-policy"
  | "billing-provider"
  | "discovery"
  | "integration-provider"
  | "federation-policy"
  | "operations";

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
  if (manifest.apiVersion !== EXTENSION_API_VERSION) throw new Error(`Extension ${manifest.id} requires unsupported API version ${manifest.apiVersion}`);
  for (const contract of requiredContracts) {
    if (!manifest.contracts.includes(contract)) throw new Error(`Extension ${manifest.id} does not implement required contract ${contract}`);
  }
};

