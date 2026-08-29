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
  /** Explicit migration-only object inventory; never populated on normal upload paths. */
  objectInventory?: readonly MigrationObjectInventoryEntry[];
  verifiedObjectCount?: number;
  rollbackUntil?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** Immutable source/destination locations recorded only for an authorized migration. */
export interface MigrationObjectInventoryEntry {
  id: string;
  source: { bucket: string; key: string; versionId?: string };
  destination: { bucket: string; key: string };
  checksum: string;
  byteLength: number;
}

/** Provider adapter used only after a migration source hold and export checkpoint exist. */
export interface MigrationObjectTransfer {
  transfer(checkpoint: MigrationCheckpoint, objects: readonly MigrationObjectInventoryEntry[]): Promise<void>;
  verify(checkpoint: MigrationCheckpoint, objects: readonly MigrationObjectInventoryEntry[]): Promise<{ objectCount: number; verifiedObjectCount: number }>;
}

/**
 * Non-secret registration held by an operator control plane. It identifies the
 * explicitly approved migration endpoint and object store for a cell; it never
 * contains credentials, creator data, or a route used by the public edge.
 */
export interface MigrationCellRegistration {
  cellId: string;
  region: string;
  endpoint: string;
  /** Private invocable endpoint identifier (for AWS, a Lambda function ARN). */
  migrationEndpoint: string;
  objectBucket: string;
  state: "active" | "draining" | "disabled";
  registeredAt: string;
  updatedAt: string;
}

/** Separate from the public routing directory, and writable only by operators. */
export interface MigrationCellRegistry {
  get(cellId: string): Promise<MigrationCellRegistration | undefined>;
  register(cell: MigrationCellRegistration): Promise<MigrationCellRegistration>;
  list(input: { limit: number; cursor?: string }): Promise<{ items: readonly MigrationCellRegistration[]; nextCursor?: string }>;
}

export type MigrationCellOperation = "source_hold" | "source_release" | "export" | "import" | "enable" | "rollback" | "retire";
export interface MigrationCellCommand {
  operation: MigrationCellOperation;
  checkpoint: MigrationCheckpoint;
  /** The destination bucket is supplied only for a migration export. */
  destinationBucket?: string;
}
export interface MigrationCellCommandResult {
  manifestChecksum?: string;
  objectInventory?: readonly MigrationObjectInventoryEntry[];
}

/**
 * Authenticated private control channel from the operator worker to a cell.
 * The transport (for example, cross-account Lambda invocation) is an adapter;
 * normal creator HTTP traffic never exposes these commands.
 */
export interface MigrationCellEndpoint {
  execute(command: MigrationCellCommand): Promise<MigrationCellCommandResult>;
}

/**
 * Optional managed-edge control plane.  Implementations retain routing and
 * migration metadata only; creator records, source objects, credentials, and
 * moderation data always remain in their regional home cell.
 */
export interface RoutingDirectory {
  get(creatorId: string): Promise<CellRoute | undefined>;
  create(route: CellRoute): Promise<CellRoute>;
  /** Atomically replaces a route only when the current routing revision matches. */
  compareAndSwap(input: { route: CellRoute; expectedRoutingRevision: number }): Promise<CellRoute>;
  list(input: { limit: number; cursor?: string }): Promise<{ items: readonly CellRoute[]; nextCursor?: string }>;
}

export interface MigrationCheckpointStore {
  get(id: string): Promise<MigrationCheckpoint | undefined>;
  create(checkpoint: MigrationCheckpoint): Promise<MigrationCheckpoint>;
  /** Optimistic update prevents two operators/workers from advancing one migration concurrently. */
  compareAndSwap(input: { checkpoint: MigrationCheckpoint; expectedUpdatedAt: string }): Promise<MigrationCheckpoint>;
  list(input: { creatorId?: string; limit: number; cursor?: string }): Promise<{ items: readonly MigrationCheckpoint[]; nextCursor?: string }>;
}

export class RoutingDirectoryConflictError extends Error {
  constructor(message: string) { super(message); this.name = "RoutingDirectoryConflictError"; }
}

/** Provider-specific workers perform these idempotent operations; core owns only the lifecycle. */
export interface MigrationExecutor {
  placeSourceHold(checkpoint: MigrationCheckpoint): Promise<void>;
  releaseSourceHold(checkpoint: MigrationCheckpoint): Promise<void>;
  exportSource(checkpoint: MigrationCheckpoint): Promise<{ manifestChecksum: string; objectCount: number; objectInventory?: readonly MigrationObjectInventoryEntry[] }>;
  transferObjects(checkpoint: MigrationCheckpoint): Promise<void>;
  importDestination(checkpoint: MigrationCheckpoint): Promise<void>;
  verifyDestination(checkpoint: MigrationCheckpoint): Promise<{ objectCount: number; verifiedObjectCount: number }>;
  enableDestination(checkpoint: MigrationCheckpoint): Promise<void>;
  rollbackDestination(checkpoint: MigrationCheckpoint): Promise<void>;
  retireSource(checkpoint: MigrationCheckpoint): Promise<void>;
}

/**
 * Composes a real migration executor from two private cell endpoints and an
 * explicit transfer adapter. The coordinator remains responsible for durable
 * checkpoint/routing transitions, while endpoints own their regional data.
 */
export class RemoteMigrationExecutor implements MigrationExecutor {
  constructor(private readonly source: MigrationCellEndpoint, private readonly destination: MigrationCellEndpoint, private readonly transfer: MigrationObjectTransfer, private readonly destinationBucket: string) {}
  async placeSourceHold(checkpoint: MigrationCheckpoint): Promise<void> { await this.source.execute({ operation: "source_hold", checkpoint }); }
  async releaseSourceHold(checkpoint: MigrationCheckpoint): Promise<void> { await this.source.execute({ operation: "source_release", checkpoint }); }
  async exportSource(checkpoint: MigrationCheckpoint): Promise<{ manifestChecksum: string; objectCount: number; objectInventory?: readonly MigrationObjectInventoryEntry[] }> {
    const result = await this.source.execute({ operation: "export", checkpoint, destinationBucket: this.destinationBucket });
    if (!result.manifestChecksum || !result.objectInventory) throw new Error("Migration source did not return a manifest checksum and object inventory.");
    return { manifestChecksum: result.manifestChecksum, objectCount: result.objectInventory.length, objectInventory: result.objectInventory };
  }
  async transferObjects(checkpoint: MigrationCheckpoint): Promise<void> {
    if (!checkpoint.objectInventory) throw new Error("Migration object inventory is missing after export.");
    await this.transfer.transfer(checkpoint, checkpoint.objectInventory);
  }
  async importDestination(checkpoint: MigrationCheckpoint): Promise<void> { await this.destination.execute({ operation: "import", checkpoint }); }
  async verifyDestination(checkpoint: MigrationCheckpoint): Promise<{ objectCount: number; verifiedObjectCount: number }> {
    if (!checkpoint.objectInventory) throw new Error("Migration object inventory is missing before verification.");
    const verified = await this.transfer.verify(checkpoint, checkpoint.objectInventory);
    if (verified.objectCount !== checkpoint.objectInventory.length || verified.verifiedObjectCount !== checkpoint.objectInventory.length) throw new Error("Migration destination object verification did not match the source inventory.");
    return verified;
  }
  async enableDestination(checkpoint: MigrationCheckpoint): Promise<void> { await this.destination.execute({ operation: "enable", checkpoint }); }
  async rollbackDestination(checkpoint: MigrationCheckpoint): Promise<void> { await this.destination.execute({ operation: "rollback", checkpoint }); }
  async retireSource(checkpoint: MigrationCheckpoint): Promise<void> { await this.source.execute({ operation: "retire", checkpoint }); }
}

/**
 * Resumable migration coordinator. Each provider operation must be idempotent:
 * a process may stop after a remote operation but before the checkpoint write.
 * No source deletion occurs before explicit post-cutover retirement.
 */
export class MigrationOrchestrator {
  private lastTimestamp = 0;
  constructor(private readonly routes: RoutingDirectory, private readonly checkpoints: MigrationCheckpointStore, private readonly executor: MigrationExecutor, private readonly clock: () => string = () => new Date().toISOString()) {}
  async request(input: { id: string; creatorId: string; destination: { cellId: string; region: string; endpoint: string } }): Promise<MigrationCheckpoint> {
    const source = await this.routes.get(input.creatorId);
    if (!source) throw new Error(`No routing entry exists for creator ${input.creatorId}.`);
    const checkpoint = createMigrationCheckpoint({ id: input.id, creatorId: input.creatorId, source, destination: input.destination, now: this.now() });
    return this.checkpoints.create(checkpoint);
  }
  async resume(id: string, rollbackWindowSeconds = 86_400): Promise<MigrationCheckpoint> {
    let checkpoint = await this.required(id);
    if (checkpoint.state === "requested") { await this.executor.placeSourceHold(checkpoint); checkpoint = await this.advance(checkpoint, "source_hold"); }
    if (checkpoint.state === "source_hold") { const exported = await this.executor.exportSource(checkpoint); checkpoint = await this.advance(checkpoint, "exported", exported); }
    if (checkpoint.state === "exported") { await this.executor.transferObjects(checkpoint); checkpoint = await this.advance(checkpoint, "transferred"); }
    if (checkpoint.state === "transferred") { await this.executor.importDestination(checkpoint); const verified = await this.executor.verifyDestination(checkpoint); checkpoint = await this.advance(checkpoint, "verified", verified); }
    if (checkpoint.state === "verified") {
      await this.executor.enableDestination(checkpoint);
      const route = await this.routes.get(checkpoint.creatorId);
      if (!route) throw new Error(`No routing entry exists for creator ${checkpoint.creatorId}.`);
      const alreadyCutOver = route.homeCellId === checkpoint.destination.cellId && route.homeRegion === checkpoint.destination.region && route.endpoint === checkpoint.destination.endpoint && route.routingRevision === checkpoint.source.routingRevision + 1;
      if (!alreadyCutOver) {
        const nextRoute = cutoverCellRoute(route, checkpoint, this.now());
        await this.routes.compareAndSwap({ route: nextRoute, expectedRoutingRevision: route.routingRevision });
      }
      checkpoint = await this.advance(checkpoint, "cutover", { rollbackUntil: new Date(Date.parse(this.now()) + rollbackWindowSeconds * 1_000).toISOString() });
    }
    return checkpoint;
  }
  async rollback(id: string): Promise<MigrationCheckpoint> {
    const checkpoint = await this.required(id);
    if (checkpoint.state !== "cutover") throw new MigrationTransitionError("Only a cut-over migration can roll back.");
    const route = await this.routes.get(checkpoint.creatorId);
    if (!route) throw new Error(`No routing entry exists for creator ${checkpoint.creatorId}.`);
    const alreadyRestored = route.homeCellId === checkpoint.source.homeCellId && route.homeRegion === checkpoint.source.homeRegion && route.endpoint === checkpoint.source.endpoint && route.routingRevision === checkpoint.source.routingRevision + 2 && route.state === "active";
    if (!alreadyRestored) {
      await this.executor.rollbackDestination(checkpoint);
      const restored = rollbackCellRoute(route, checkpoint, this.now());
      await this.routes.compareAndSwap({ route: restored, expectedRoutingRevision: route.routingRevision });
    }
    // Restore write authority only after the edge route has atomically returned
    // to the source. A failed release therefore remains safely held and can be
    // retried without moving the route again.
    await this.executor.releaseSourceHold(checkpoint);
    return this.advance(checkpoint, "rolled_back");
  }
  async retire(id: string): Promise<MigrationCheckpoint> {
    const checkpoint = await this.required(id);
    if (checkpoint.state !== "cutover") throw new MigrationTransitionError("Only a cut-over migration can retire its source.");
    if (checkpoint.rollbackUntil && Date.parse(checkpoint.rollbackUntil) > Date.parse(this.now())) throw new MigrationTransitionError("The rollback retention window has not expired.");
    await this.executor.retireSource(checkpoint);
    return this.advance(checkpoint, "retired");
  }
  private async required(id: string): Promise<MigrationCheckpoint> { const checkpoint = await this.checkpoints.get(id); if (!checkpoint) throw new Error(`Migration checkpoint ${id} was not found.`); return checkpoint; }
  private async advance(checkpoint: MigrationCheckpoint, state: MigrationState, input: Omit<Parameters<typeof advanceMigration>[2], "now"> = {}): Promise<MigrationCheckpoint> {
    const next = advanceMigration(checkpoint, state, { ...input, now: this.now() });
    return this.checkpoints.compareAndSwap({ checkpoint: next, expectedUpdatedAt: checkpoint.updatedAt });
  }
  private now(): string { const requested = Date.parse(this.clock()); this.lastTimestamp = Math.max(this.lastTimestamp + 1, Number.isFinite(requested) ? requested : Date.now()); return new Date(this.lastTimestamp).toISOString(); }
}

/** Builds a same-method redirect to a home cell without proxying creator writes. */
export const routeToHomeCell = (route: CellRoute, relativePath: string): { endpoint: string; routingRevision: number; location: string } => {
  validateCellRoute(route);
  if (!relativePath.startsWith("/") || relativePath.startsWith("//")) throw new Error("A routed request path must be an absolute local path.");
  const location = new URL(relativePath, route.endpoint).toString();
  return { endpoint: route.endpoint, routingRevision: route.routingRevision, location };
};

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

/** Validates the operator-only registry record without treating it as edge data. */
export const validateMigrationCellRegistration = (cell: MigrationCellRegistration): MigrationCellRegistration => {
  if (!cell.cellId.trim() || !cell.region.trim() || !validEndpoint(cell.endpoint) || !cell.migrationEndpoint.trim() || !cell.objectBucket.trim() || !["active", "draining", "disabled"].includes(cell.state) || Number.isNaN(Date.parse(cell.registeredAt)) || Number.isNaN(Date.parse(cell.updatedAt))) throw new Error("Migration cell registration is invalid");
  return cell;
};

export const validateMigrationCheckpoint = (checkpoint: MigrationCheckpoint): MigrationCheckpoint => {
  createMigrationCheckpoint({ ...checkpoint, now: checkpoint.createdAt });
  if (!transition[checkpoint.state] || Number.isNaN(Date.parse(checkpoint.updatedAt))) throw new Error("Migration checkpoint is invalid");
  return checkpoint;
};

export const createMigrationCheckpoint = (input: Omit<MigrationCheckpoint, "state" | "createdAt" | "updatedAt"> & { now?: string }): MigrationCheckpoint => {
  if (!input.id.trim() || !input.creatorId.trim() || !input.source.homeCellId.trim() || !input.source.homeRegion.trim() || !validEndpoint(input.source.endpoint) || !Number.isSafeInteger(input.source.routingRevision) || input.source.routingRevision < 1 || !input.destination.cellId.trim() || !input.destination.region.trim() || !validEndpoint(input.destination.endpoint) || input.source.homeCellId === input.destination.cellId) throw new Error("Migration checkpoint is invalid");
  const now = input.now ?? new Date().toISOString();
  return { ...input, state: "requested", createdAt: now, updatedAt: now };
};

/** Advances only the documented migration lifecycle; terminal states cannot be reopened. */
export const advanceMigration = (checkpoint: MigrationCheckpoint, state: MigrationState, input: { now: string; manifestChecksum?: string; objectCount?: number; objectInventory?: readonly MigrationObjectInventoryEntry[]; verifiedObjectCount?: number; rollbackUntil?: string; failureReason?: string }): MigrationCheckpoint => {
  if (!transition[checkpoint.state].includes(state)) throw new MigrationTransitionError(`Cannot move migration from ${checkpoint.state} to ${state}`);
  if (state === "exported" && !/^[a-f0-9]{64}$/i.test(input.manifestChecksum ?? "")) throw new MigrationTransitionError("An exported migration requires a manifest checksum");
  if (input.objectInventory && (input.objectInventory.length !== input.objectCount || input.objectInventory.some((object) => !object.id.trim() || !object.source.bucket.trim() || !object.source.key.trim() || !object.destination.bucket.trim() || !object.destination.key.trim() || !/^[a-f0-9]{64}$/i.test(object.checksum) || !Number.isSafeInteger(object.byteLength) || object.byteLength < 0))) throw new MigrationTransitionError("Migration object inventory is invalid");
  if (state === "verified") {
    const objectCount = input.objectCount, verifiedObjectCount = input.verifiedObjectCount;
    if (objectCount === undefined || verifiedObjectCount === undefined || !Number.isSafeInteger(objectCount) || !Number.isSafeInteger(verifiedObjectCount) || objectCount < 0 || objectCount !== verifiedObjectCount) throw new MigrationTransitionError("Destination object verification must match the source inventory");
  }
  if (state === "cutover" && (!input.rollbackUntil || Date.parse(input.rollbackUntil) <= Date.parse(input.now))) throw new MigrationTransitionError("Cutover requires a future rollback window");
  if (state === "rolled_back" && checkpoint.state !== "cutover") throw new MigrationTransitionError("Only a cut-over migration can roll back");
  if (state === "failed" && !input.failureReason?.trim()) throw new MigrationTransitionError("A failed migration requires an auditable reason");
  return { ...checkpoint, state, manifestChecksum: input.manifestChecksum ?? checkpoint.manifestChecksum, objectCount: input.objectCount ?? checkpoint.objectCount, objectInventory: input.objectInventory ?? checkpoint.objectInventory, verifiedObjectCount: input.verifiedObjectCount ?? checkpoint.verifiedObjectCount, rollbackUntil: input.rollbackUntil ?? checkpoint.rollbackUntil, failureReason: input.failureReason, updatedAt: input.now };
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
