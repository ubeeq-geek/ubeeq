/** Product-neutral remote integration capabilities. */
export const INTEGRATION_CAPABILITIES = [
  "connect", "catalogue_import", "source_migration", "publish", "remote_update",
  "remote_delete", "engagement_read", "engagement_write", "webhook_receive", "reconcile"
] as const;
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number];

export type IntegrationOperation =
  | "connect"
  | "import"
  | "migrate_source"
  | "publish"
  | "update_remote"
  | "delete_remote"
  | "read_engagement"
  | "write_engagement"
  | "receive_webhook"
  | "reconcile";

export interface IntegrationDefinition {
  id: string;
  capabilities: readonly IntegrationCapability[];
  credentialCustody: "application" | "isolated_broker";
  ownerModel: "creator" | "user" | "workspace";
  connectionModel: "external_account" | "native_connection";
}

const requiredCapability: Record<IntegrationOperation, IntegrationCapability> = {
  connect: "connect", import: "catalogue_import", migrate_source: "source_migration", publish: "publish",
  update_remote: "remote_update", delete_remote: "remote_delete", read_engagement: "engagement_read",
  write_engagement: "engagement_write", receive_webhook: "webhook_receive", reconcile: "reconcile"
};

export const supportsIntegrationOperation = (definition: IntegrationDefinition, operation: IntegrationOperation): boolean =>
  definition.capabilities.includes(requiredCapability[operation]);

export class UnsupportedIntegrationOperationError extends Error {
  constructor(readonly integrationId: string, readonly operation: IntegrationOperation) {
    super(`Integration ${integrationId} does not support ${operation}.`);
    this.name = "UnsupportedIntegrationOperationError";
  }
}

export const requireIntegrationOperation = (definition: IntegrationDefinition, operation: IntegrationOperation): void => {
  if (!supportsIntegrationOperation(definition, operation)) throw new UnsupportedIntegrationOperationError(definition.id, operation);
};

export const integrationConformanceScenarios = [
  "oauth-expiry", "pagination", "rate-limit-backoff", "duplicate-retry",
  "remote-deletion", "unsupported-fields", "reconciliation"
] as const;
export type IntegrationConformanceScenario = typeof integrationConformanceScenarios[number];

export interface IntegrationConformanceEvidence { assertions: number; summary: string; }
export interface IntegrationConformanceAdapter {
  integrationId: string;
  scenarios: Record<IntegrationConformanceScenario, () => Promise<IntegrationConformanceEvidence>>;
}

export const runIntegrationConformanceSuite = async (adapter: IntegrationConformanceAdapter): Promise<void> => {
  for (const scenario of integrationConformanceScenarios) {
    const evidence = await adapter.scenarios[scenario]();
    if (!Number.isInteger(evidence?.assertions) || evidence.assertions < 1 || !evidence.summary.trim()) {
      throw new Error(`${adapter.integrationId} conformance scenario ${scenario} did not report executable assertions.`);
    }
  }
};
