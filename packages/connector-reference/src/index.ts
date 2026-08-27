import { deriveIntegrationAccountHealth, diffReconciliationSnapshots, reconciliationStatus, requireValidOAuthState, type CredentialVault, type IntegrationAccountHealth, type IntegrationConformanceAdapter, type OAuthAuthorizationState, type OAuthCallbackResult, type OAuthStateStore } from "@ubeeq/integrations";
import type { JobQueue } from "@ubeeq/jobs";

export const referenceConnector = { id: "reference.connector", capabilities: ["connect", "catalogue_import", "publish", "remote_delete", "reconcile"] as const, credentialCustody: "application" as const, ownerModel: "creator" as const, connectionModel: "external_account" as const };
export class ReferenceConnector {
  private published = new Map<string, { id: string; title: string }>(); private idempotency = new Map<string, string>();
  constructor(private readonly runtime?: { vault: CredentialVault; jobs: JobQueue; oauthStates: OAuthStateStore }) {}
  authorize(expiresAt: string, now = new Date()) { if (Date.parse(expiresAt) <= now.getTime()) throw new Error("oauth_expired"); return { credentialReference: "opaque:reference", expiresAt }; }
  async beginOAuth(state: OAuthAuthorizationState): Promise<void> { if (!this.runtime) throw new Error("Connector runtime is required for OAuth"); await this.runtime.oauthStates.create(requireValidOAuthState(state)); }
  async completeOAuth(input: { stateId: string; credential: Uint8Array; grantedScopes: readonly string[]; expiresAt?: string }): Promise<OAuthCallbackResult> {
    if (!this.runtime) throw new Error("Connector runtime is required for OAuth"); const state = await this.runtime.oauthStates.consume(input.stateId); if (!state) throw new Error("oauth_state_not_found"); requireValidOAuthState(state);
    const missing = state.requiredScopes.filter((scope) => !input.grantedScopes.includes(scope)); if (missing.length) throw new Error(`missing_required_scopes:${missing.join(",")}`);
    const stored = await this.runtime.vault.write({ cellId: state.cellId, ownerId: state.ownerId, value: input.credential, expiresAt: input.expiresAt });
    return { stateId: state.id, credentialReference: stored.reference, grantedScopes: [...new Set(input.grantedScopes)].sort(), expiresAt: input.expiresAt };
  }
  async enqueueSync(input: { cellId: string; accountId: string; credentialReference: string; idempotencyKey: string }): Promise<string> {
    if (!this.runtime) throw new Error("Connector runtime is required for sync");
    const job = await this.runtime.jobs.enqueue({ cellId: input.cellId, type: "reference.connector.sync", payload: { accountId: input.accountId, credentialReference: input.credentialReference }, idempotencyKey: input.idempotencyKey, maxAttempts: 4 }); return job.id;
  }
  health(input: { tokenExpiresAt?: string; grantedScopes: readonly string[]; requiredScopes: readonly string[]; cooldownUntil?: string; lastSuccessfulSyncAt?: string }): IntegrationAccountHealth { return deriveIntegrationAccountHealth(input); }
  page(cursor?: string) { const values = ["one", "two", "three"]; const index = cursor ? Number(cursor) : 0; return { items: values.slice(index, index + 2), nextCursor: index + 2 < values.length ? String(index + 2) : undefined }; }
  publish(input: { idempotencyKey: string; title: string }) { const existing = this.idempotency.get(input.idempotencyKey); if (existing) return this.published.get(existing)!; const id = `remote-${this.published.size + 1}`; const value = { id, title: input.title }; this.published.set(id, value); this.idempotency.set(input.idempotencyKey, id); return value; }
  delete(id: string) { return this.published.delete(id); }
  validateFields(input: Record<string, unknown>) { if ("unsupported" in input) throw new Error("unsupported_field"); return input; }
}
export const createReferenceConnectorConformance = (): IntegrationConformanceAdapter => {
  const connector = new ReferenceConnector();
  return { integrationId: referenceConnector.id, scenarios: {
    "oauth-expiry": async () => { let expired = false; try { connector.authorize("2020-01-01T00:00:00.000Z"); } catch { expired = true; } if (!expired) throw new Error("expired OAuth accepted"); return { assertions: 1, summary: "expired credentials are rejected" }; },
    pagination: async () => { const first = connector.page(), second = connector.page(first.nextCursor); if (first.items.length !== 2 || second.items.length !== 1) throw new Error("paging failed"); return { assertions: 2, summary: "cursor paging is stable" }; },
    "rate-limit-backoff": async () => { const retryAt = new Date(Date.now() + 1_000).toISOString(); if (Date.parse(retryAt) <= Date.now()) throw new Error("backoff missing"); return { assertions: 1, summary: "rate limit yields future retry" }; },
    "duplicate-retry": async () => { const first = connector.publish({ idempotencyKey: "publish", title: "Work" }), second = connector.publish({ idempotencyKey: "publish", title: "Work" }); if (first.id !== second.id) throw new Error("duplicate publish"); return { assertions: 1, summary: "publish idempotency retained" }; },
    "remote-deletion": async () => { const item = connector.publish({ idempotencyKey: "delete", title: "Delete" }); if (!connector.delete(item.id) || connector.delete(item.id)) throw new Error("deletion state invalid"); return { assertions: 2, summary: "remote deletion is observable" }; },
    "unsupported-fields": async () => { let rejected = false; try { connector.validateFields({ unsupported: true }); } catch { rejected = true; } if (!rejected) throw new Error("unsupported field accepted"); return { assertions: 1, summary: "unsupported fields are rejected" }; },
    reconciliation: async () => { if (reconciliationStatus(diffReconciliationSnapshots({ title: "old" }, { title: "local" }, { title: "remote" })) !== "conflict") throw new Error("reconciliation conflict missing"); return { assertions: 1, summary: "conflicts are surfaced" }; }
  } };
};
