export interface DeploymentArtifact { path: string; fileCount: number; sha256: string; }
export interface DeploymentArtifactManifest { schemaVersion: 1; product: string; revision: string; artifacts: Readonly<Record<string, DeploymentArtifact>>; }
export interface RegionalDeploymentPlan { regions: readonly string[]; artifactRegistryStackName: string; }

/** Minimal, non-content directory entry suitable for an optional managed edge. */
export interface CellRoute {
  creatorId: string;
  homeCellId: string;
  homeRegion: string;
  endpoint: string;
  routingRevision: number;
  state: "active" | "migration_pending" | "cutover_pending" | "rollback_available";
  updatedAt: string;
}

export type MigrationState = "requested" | "source_hold" | "exported" | "transferred" | "verified" | "cutover" | "rolled_back" | "retired" | "failed";
export interface MigrationCheckpoint {
  id: string;
  creatorId: string;
  source: Pick<CellRoute, "homeCellId" | "homeRegion" | "endpoint" | "routingRevision">;
  destination: { cellId: string; region: string; endpoint: string };
  state: MigrationState;
  manifestChecksum?: string;
  objectCount?: number;
  verifiedObjectCount?: number;
  rollbackUntil?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export class MigrationTransitionError extends Error {
  constructor(message: string) { super(message); this.name = "MigrationTransitionError"; }
}

const validEndpoint = (value: string): boolean => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/"; }
  catch { return false; }
};

const transition: Readonly<Record<MigrationState, readonly MigrationState[]>> = {
  requested: ["source_hold", "failed"], source_hold: ["exported", "failed"], exported: ["transferred", "failed"],
  transferred: ["verified", "failed"], verified: ["cutover", "failed"], cutover: ["rolled_back", "retired"],
  rolled_back: [], retired: [], failed: []
};

export const validateCellRoute = (route: CellRoute): CellRoute => {
  if (!route.creatorId.trim() || !route.homeCellId.trim() || !route.homeRegion.trim() || !validEndpoint(route.endpoint) || !Number.isSafeInteger(route.routingRevision) || route.routingRevision < 1 || Number.isNaN(Date.parse(route.updatedAt))) throw new Error("Cell route is invalid");
  return route;
};

export const createMigrationCheckpoint = (input: Omit<MigrationCheckpoint, "state" | "createdAt" | "updatedAt"> & { now?: string }): MigrationCheckpoint => {
  if (!input.id.trim() || !input.creatorId.trim() || !input.source.homeCellId.trim() || !input.source.homeRegion.trim() || !validEndpoint(input.source.endpoint) || !Number.isSafeInteger(input.source.routingRevision) || input.source.routingRevision < 1 || !input.destination.cellId.trim() || !input.destination.region.trim() || !validEndpoint(input.destination.endpoint) || input.source.homeCellId === input.destination.cellId) throw new Error("Migration checkpoint is invalid");
  const now = input.now ?? new Date().toISOString();
  return { ...input, state: "requested", createdAt: now, updatedAt: now };
};

/** Advances only the documented migration lifecycle; terminal states cannot be reopened. */
export const advanceMigration = (checkpoint: MigrationCheckpoint, state: MigrationState, input: { now: string; manifestChecksum?: string; objectCount?: number; verifiedObjectCount?: number; rollbackUntil?: string; failureReason?: string }): MigrationCheckpoint => {
  if (!transition[checkpoint.state].includes(state)) throw new MigrationTransitionError(`Cannot move migration from ${checkpoint.state} to ${state}`);
  if (state === "exported" && !/^[a-f0-9]{64}$/i.test(input.manifestChecksum ?? "")) throw new MigrationTransitionError("An exported migration requires a manifest checksum");
  if (state === "verified") {
    const objectCount = input.objectCount, verifiedObjectCount = input.verifiedObjectCount;
    if (objectCount === undefined || verifiedObjectCount === undefined || !Number.isSafeInteger(objectCount) || !Number.isSafeInteger(verifiedObjectCount) || objectCount < 0 || objectCount !== verifiedObjectCount) throw new MigrationTransitionError("Destination object verification must match the source inventory");
  }
  if (state === "cutover" && (!input.rollbackUntil || Date.parse(input.rollbackUntil) <= Date.parse(input.now))) throw new MigrationTransitionError("Cutover requires a future rollback window");
  if (state === "rolled_back" && checkpoint.state !== "cutover") throw new MigrationTransitionError("Only a cut-over migration can roll back");
  if (state === "failed" && !input.failureReason?.trim()) throw new MigrationTransitionError("A failed migration requires an auditable reason");
  return { ...checkpoint, state, manifestChecksum: input.manifestChecksum ?? checkpoint.manifestChecksum, objectCount: input.objectCount ?? checkpoint.objectCount, verifiedObjectCount: input.verifiedObjectCount ?? checkpoint.verifiedObjectCount, rollbackUntil: input.rollbackUntil ?? checkpoint.rollbackUntil, failureReason: input.failureReason, updatedAt: input.now };
};

/** Route cutover is an explicit compare-and-swap over the source routing revision. */
export const cutoverCellRoute = (route: CellRoute, checkpoint: MigrationCheckpoint, now: string): CellRoute => {
  validateCellRoute(route);
  if (checkpoint.state !== "verified" || checkpoint.creatorId !== route.creatorId || checkpoint.source.homeCellId !== route.homeCellId || checkpoint.source.routingRevision !== route.routingRevision) throw new MigrationTransitionError("Migration is not verified for this current route");
  return { creatorId: route.creatorId, homeCellId: checkpoint.destination.cellId, homeRegion: checkpoint.destination.region, endpoint: checkpoint.destination.endpoint, routingRevision: route.routingRevision + 1, state: "rollback_available", updatedAt: now };
};

/** Rollback is deliberately limited to the retained source and original revision. */
export const rollbackCellRoute = (route: CellRoute, checkpoint: MigrationCheckpoint, now: string): CellRoute => {
  if (checkpoint.state !== "cutover" || route.creatorId !== checkpoint.creatorId || route.homeCellId !== checkpoint.destination.cellId || route.routingRevision !== checkpoint.source.routingRevision + 1 || !checkpoint.rollbackUntil || Date.parse(checkpoint.rollbackUntil) < Date.parse(now)) throw new MigrationTransitionError("Migration is not eligible for rollback");
  return { creatorId: route.creatorId, homeCellId: checkpoint.source.homeCellId, homeRegion: checkpoint.source.homeRegion, endpoint: checkpoint.source.endpoint, routingRevision: route.routingRevision + 1, state: "active", updatedAt: now };
};

export const validateDeploymentArtifactManifest = (manifest: DeploymentArtifactManifest, expected: { product: string; revision: string; artifacts: readonly string[] }): DeploymentArtifactManifest => {
  if (manifest.schemaVersion !== 1 || manifest.product !== expected.product || manifest.revision !== expected.revision) throw new Error("Deployment artifact manifest identity does not match the planned release");
  if (JSON.stringify(Object.keys(manifest.artifacts).sort()) !== JSON.stringify([...expected.artifacts].sort())) throw new Error("Deployment artifact manifest components do not match the planned release");
  for (const artifact of Object.values(manifest.artifacts)) {
    if (!artifact.path || !Number.isInteger(artifact.fileCount) || artifact.fileCount < 1 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Deployment artifact manifest contains an invalid artifact");
  }
  return manifest;
};

export const validateRegionalDeploymentPlan = (plan: RegionalDeploymentPlan): RegionalDeploymentPlan => {
  if (!plan.artifactRegistryStackName.trim() || plan.regions.length === 0 || new Set(plan.regions).size !== plan.regions.length || plan.regions.some((region) => !/^[a-z]{2}-[a-z]+-\d$/.test(region))) throw new Error("Regional deployment plan is invalid");
  return plan;
};
