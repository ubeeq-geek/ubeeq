import type { IntegrationCapability, IntegrationDefinition } from "./index.js";

/**
 * Product-neutral contracts intended for MCP or other external automation surfaces.
 * These contracts deliberately describe Ubeeq intent rather than MCP transport details.
 */
export const MCP_CONTROL_PERMISSIONS = [
  "integrations.read",
  "works.read",
  "flows.read",
  "flows.write",
  "publications.write",
  "revisions.read",
  "revisions.rollback"
] as const;
export type McpControlPermission = (typeof MCP_CONTROL_PERMISSIONS)[number];

export const MCP_CONTROL_TOOLS = [
  "integrations.list",
  "integrations.capabilities.get",
  "works.flow.get",
  "works.flow.preview",
  "works.flow.apply",
  "publications.publish",
  "revisions.list",
  "revisions.rollback"
] as const;
export type McpControlToolName = (typeof MCP_CONTROL_TOOLS)[number];

export const requiredMcpPermission: Record<McpControlToolName, McpControlPermission> = {
  "integrations.list": "integrations.read",
  "integrations.capabilities.get": "integrations.read",
  "works.flow.get": "flows.read",
  "works.flow.preview": "flows.read",
  "works.flow.apply": "flows.write",
  "publications.publish": "publications.write",
  "revisions.list": "revisions.read",
  "revisions.rollback": "revisions.rollback"
};

export interface McpControlPrincipal {
  subjectId: string;
  permissions: readonly McpControlPermission[];
}

export class McpControlAuthorizationError extends Error {
  constructor(readonly tool: McpControlToolName, readonly permission: McpControlPermission) {
    super(`MCP control tool ${tool} requires ${permission}.`);
    this.name = "McpControlAuthorizationError";
  }
}

export const authorizeMcpControlTool = (principal: McpControlPrincipal, tool: McpControlToolName): void => {
  const required = requiredMcpPermission[tool];
  if (!principal.permissions.includes(required)) throw new McpControlAuthorizationError(tool, required);
};

/** "ubeeq" means the shared Work value is intentionally authored in Ubeeq. */
export type FlowEndpoint = "ubeeq" | `integration:${string}`;
export type FlowMode = "automatic" | "manual";

export interface WorkFieldFlowRule {
  field: string;
  /** At most one upstream may automatically update the shared Work field. */
  upstream?: { endpoint: FlowEndpoint; mode: FlowMode };
  /** Zero or more downstream publications may receive compatible Work-field changes. */
  downstream: readonly { endpoint: FlowEndpoint; mode: FlowMode }[];
}

export interface WorkFlowPolicy {
  workId: string;
  revision: number;
  fields: readonly WorkFieldFlowRule[];
}

export interface IntegrationCapabilityView {
  id: string;
  capabilities: readonly IntegrationCapability[];
}

export const integrationCapabilityView = (definition: IntegrationDefinition): IntegrationCapabilityView => ({
  id: definition.id,
  capabilities: [...definition.capabilities]
});

const requireEndpoint = (endpoint: FlowEndpoint): void => {
  if (endpoint === "ubeeq") return;
  if (!endpoint.startsWith("integration:") || !endpoint.slice("integration:".length).trim()) {
    throw new Error(`Invalid flow endpoint: ${endpoint}`);
  }
};

/**
 * Validate the deterministic routing invariants used by both human UI and external assistants.
 * Platform capability validation remains caller-owned because it depends on connected accounts.
 */
export const validateWorkFlowPolicy = (policy: WorkFlowPolicy): WorkFlowPolicy => {
  if (!policy.workId.trim()) throw new Error("Work flow policy requires a work ID.");
  if (!Number.isInteger(policy.revision) || policy.revision < 0) throw new Error("Work flow policy revision must be a non-negative integer.");

  const fields = new Set<string>();
  for (const rule of policy.fields) {
    const field = rule.field.trim();
    if (!field) throw new Error("Work flow rules require a field name.");
    if (fields.has(field)) throw new Error(`Duplicate work flow field: ${field}`);
    fields.add(field);

    if (rule.upstream) requireEndpoint(rule.upstream.endpoint);
    const downstream = new Set<string>();
    for (const target of rule.downstream) {
      requireEndpoint(target.endpoint);
      if (target.endpoint === "ubeeq") throw new Error(`Ubeeq cannot be a downstream destination for ${field}.`);
      if (rule.upstream?.endpoint === target.endpoint) throw new Error(`Flow endpoint ${target.endpoint} cannot be both upstream and downstream for ${field}.`);
      if (downstream.has(target.endpoint)) throw new Error(`Duplicate downstream endpoint ${target.endpoint} for ${field}.`);
      downstream.add(target.endpoint);
    }
  }

  return structuredClone(policy);
};

export type WorkFlowPolicyMutation =
  | { type: "set_upstream"; field: string; endpoint?: FlowEndpoint; mode?: FlowMode }
  | { type: "set_downstream"; field: string; endpoint: FlowEndpoint; mode: FlowMode }
  | { type: "remove_downstream"; field: string; endpoint: FlowEndpoint };

export interface WorkFlowPolicyPreview {
  currentRevision: number;
  next: WorkFlowPolicy;
  changedFields: readonly string[];
  warnings: readonly string[];
}

const cloneRule = (rule: WorkFieldFlowRule): WorkFieldFlowRule => ({
  field: rule.field,
  upstream: rule.upstream ? { ...rule.upstream } : undefined,
  downstream: rule.downstream.map((item) => ({ ...item }))
});

export const previewWorkFlowPolicyMutation = (
  current: WorkFlowPolicy,
  mutations: readonly WorkFlowPolicyMutation[]
): WorkFlowPolicyPreview => {
  const validated = validateWorkFlowPolicy(current);
  const rules = new Map(validated.fields.map((rule) => [rule.field, cloneRule(rule)]));
  const changedFields = new Set<string>();

  const getRule = (fieldInput: string): WorkFieldFlowRule => {
    const field = fieldInput.trim();
    if (!field) throw new Error("Work flow mutation requires a field name.");
    const existing = rules.get(field) ?? { field, downstream: [] };
    if (!rules.has(field)) rules.set(field, existing);
    return existing;
  };

  for (const mutation of mutations) {
    const rule = getRule(mutation.field);
    changedFields.add(rule.field);

    if (mutation.type === "set_upstream") {
      rule.upstream = mutation.endpoint ? { endpoint: mutation.endpoint, mode: mutation.mode ?? "automatic" } : undefined;
      continue;
    }

    if (mutation.type === "set_downstream") {
      const remaining = rule.downstream.filter((item) => item.endpoint !== mutation.endpoint);
      rule.downstream = [...remaining, { endpoint: mutation.endpoint, mode: mutation.mode }];
      continue;
    }

    rule.downstream = rule.downstream.filter((item) => item.endpoint !== mutation.endpoint);
  }

  const next = validateWorkFlowPolicy({
    workId: validated.workId,
    revision: validated.revision + 1,
    fields: [...rules.values()].sort((left, right) => left.field.localeCompare(right.field))
  });

  return {
    currentRevision: validated.revision,
    next,
    changedFields: [...changedFields].sort(),
    warnings: []
  };
};

export interface McpMutationEnvelope<T> {
  principal: McpControlPrincipal;
  idempotencyKey: string;
  expectedRevision: number;
  input: T;
}

export const validateMcpMutationEnvelope = <T>(envelope: McpMutationEnvelope<T>): McpMutationEnvelope<T> => {
  if (!envelope.principal.subjectId.trim()) throw new Error("MCP mutation principal requires a subject ID.");
  if (!envelope.idempotencyKey.trim()) throw new Error("MCP mutation requires an idempotency key.");
  if (!Number.isInteger(envelope.expectedRevision) || envelope.expectedRevision < 0) throw new Error("MCP mutation expected revision must be a non-negative integer.");
  return structuredClone(envelope);
};

/**
 * Application-facing port. An MCP server should adapt its protocol requests to this interface;
 * it should not bypass authorization, optimistic concurrency, or policy validation.
 */
export interface McpIntegrationControlPlane {
  listIntegrations(principal: McpControlPrincipal): Promise<readonly IntegrationCapabilityView[]>;
  getWorkFlowPolicy(principal: McpControlPrincipal, workId: string): Promise<WorkFlowPolicy>;
  previewWorkFlowPolicy(principal: McpControlPrincipal, workId: string, mutations: readonly WorkFlowPolicyMutation[]): Promise<WorkFlowPolicyPreview>;
  applyWorkFlowPolicy(envelope: McpMutationEnvelope<{ workId: string; mutations: readonly WorkFlowPolicyMutation[] }>): Promise<WorkFlowPolicy>;
}
