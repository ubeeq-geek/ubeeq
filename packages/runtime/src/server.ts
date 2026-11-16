import {ReferenceRuntimeLifetime} from './runtime-lifetime.js';
import {createRetainedSourceFileNodeHandler} from './retained-source-http.js';
import {createContentPreparationNodeHandler,type ContentPreparationRuntimeBindings} from './content-preparation-node.js';
import { TenancyAdmissionError } from '@ubeeq/extension-sdk';
import { UploadLifecycle, UploadLifecycleError } from './upload-lifecycle.js';
import { OwnedObjectWrites } from './owned-object-writes.js';
import {persistProcessedOutputs} from './processed-outputs.js';
import { OwnedWebsiteBlobs } from './owned-website-blobs.js';
import { createIntakeWork, WorkIntakeError } from './work-intake.js';
import { createIntakeCreator, persistIntakeCreator, CreatorIntakeError } from './creator-intake.js';
import {withCollectionWorkLifecycleFence,RepositoryCreatorCollectionStore,CollectionManagementError,createCollectionFromIntent,invalidateCollectionDirectoryForImport,type RuntimeCollection} from './creator-collections.js';
import { UsageSettlementOutbox } from './usage-settlement-outbox.js';
import {StorageClosureOutbox} from './storage-closure-outbox.js';
import type { WebsiteGallery, WebsiteDependency } from '@ubeeq/core';
import { createReferenceCommerce, referenceCommerceConfigurationFromEnvironment, type ReferenceCommerceConfiguration, type ReferenceCommerceDependencies } from './commerce.js';
import type { WebsitePublicAsset } from '@ubeeq/portability';
import { WebsiteError, normalizeContentSlug,CreatorCollectionService,CreatorCollectionError } from '@ubeeq/core';
import { handleWebsiteHostingRequest } from './website-hosting.js';
import { handleHostingConnectionRequest } from './website-hosting-connections.js';
import { WebsiteHostingConnections, NetlifyWebsiteHostingAdapter, CloudflarePagesWebsiteHostingAdapter, SftpWebsiteHostingAdapter, connectWebsiteSftp } from '@ubeeq/integrations';
import { createHostingPublicProbe } from '@ubeeq/integrations';
import { NativeWebsiteHostingAdapter, type NativeWebsiteHostingProfile } from '@ubeeq/adapter-local';
import { WebsitePublishingService } from '@ubeeq/portability';
import { handleWebsiteRequest } from './websites.js';
import {createWebsiteSourceReader,mapWebsiteSources} from './website-sources.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { PublicationService, PublicationRequestError } from '@ubeeq/api';
import { createLocalAdapterSet, SqliteWebsiteStore, type LocalAdapterConfiguration } from "@ubeeq/adapter-local";
import { SingleOperatorTenancyAdapter, AuthorizationDeniedError, PasswordAuthenticationError, requireAuthorization, type AuthorizationRequirement, type IdentityAdapter, type PasswordIdentityAdapter, type PasswordAuthenticationPort } from "@ubeeq/auth";
import { SingleOperatorLimitError, FeatureDisabledInSingleOperatorModeError, type TenancyAndAccessPort, type HostExtensionRuntimePorts, createDefaultOpenCorePorts } from "@ubeeq/extension-sdk";
import { CellRoutingError, composeReferenceApplication, requireHomeCell, type DependencyDiagnostic } from "@ubeeq/api";
import type { JobQueue } from "@ubeeq/jobs";
import { JobRecoveryError, requireRecoverableJob } from "@ubeeq/jobs";
import { repositoryItems, type Page, type PageRequest } from "@ubeeq/persistence";
import { AdmissionBlockedError, requireAdmission, type ReviewHold } from "@ubeeq/moderation";
import { WebsiteService, websiteDigest, creatorAssetObjectInventory, createCreatorExport, planCreatorImport, validateCreatorExport, restorePublicationImageRecord } from "@ubeeq/portability";
import { LocalImageProcessor, type MediaProcessor } from "@ubeeq/processing";
import { validateRemotePublicationEvent, verifyFederationEnvelope, type FederationReplayStore, type FederationSignatureVerifier } from "@ubeeq/federation";
import type { FederationPolicy } from "@ubeeq/extension-sdk";
import { CellOwnershipError, UniqueConstraintError, OptimisticConcurrencyError, type AssetRecord, type CreatorRecord, type ImportCheckpointRecord, type WebsiteStore, type WebsiteHostingStore, type WebsiteBlobStore, type UbeeqRepositories, type WorkRecord } from "@ubeeq/persistence";
import { cellScopedObjectKey, requireCreatorScopedObject, type StoredObject, type DeliveryAdapter, type ObjectStorage, type UploadAdapter, type UploadContentAdapter } from "@ubeeq/storage";
import { routeToHomeCell, type MigrationCheckpointStore, type MigrationOrchestrator, type RoutingDirectory } from "@ubeeq/deployment-platform";

const json = (response: ServerResponse, status: number, body: unknown, requestId: string): void => {
  response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8"); response.setHeader("x-request-id", requestId); response.end(JSON.stringify(body));
};
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const allRecords = async <T>(repository: { list(request: PageRequest): Promise<Page<T>> }): Promise<T[]> => {
  const items: T[] = [];
  for await (const item of repositoryItems(request => repository.list(request))) items.push(item);
  return items;
};
const requireString = (value: unknown, field: string): string => { if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "invalid_request", `${field} is required`); return value.trim(); };
const pageRequest = (url: URL) => ({ cursor: url.searchParams.get("cursor") || undefined, limit: Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50) || 50)) });
const parseBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []; let size = 0;
  request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 10 * 1024 * 1024) reject(new HttpError(413, "payload_too_large", "Request body exceeds 10 MiB")); else chunks.push(chunk); });
  request.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new HttpError(400, "invalid_json", "Request body must be JSON")); } });
  request.on("error", reject);
});

export type ReferenceAdapterSet = {
  /** Concrete adapter-set resource owner. Core calls this only with the
   * explicit runtime ownership configuration; injected sets default to host. */
  close?():Promise<void>;
  repositories: UbeeqRepositories;
  storage: ObjectStorage;
  uploads: UploadAdapter & Partial<UploadContentAdapter>;
  delivery: DeliveryAdapter;
  jobs: JobQueue;
  identity: IdentityAdapter;
  localIdentity?: PasswordIdentityAdapter;
  passwordAuthentication?: PasswordAuthenticationPort;
  credentials?: import('@ubeeq/integrations').CredentialVault;
  federation?: FederationSignatureVerifier & FederationReplayStore & { keyId: string; publicKey: string };
};

/** Injected lifetimes default to host ownership; an actual runtime transfer is explicit. Optional cache ports
 * support unmetered adapters; metered runtimes use their owned-write journal. */
export interface RuntimeWebsitePersistence extends WebsiteStore,WebsiteHostingStore {
  /** Optional concrete same-domain execution scope. Core supplies its actual
   * verified identity/Creator and the original durable JobLease; the host may
   * not infer an actor from a workspace or lend request-only roles to a worker. */
  withWebsiteRequest?<T>(subject:NonNullable<Awaited<ReturnType<IdentityAdapter['verifySession']>>>['subject'],actor:import('@ubeeq/portability').WebsiteActor,operation:()=>Promise<T>,active?:()=>boolean):Promise<T>;
  withWebsiteJob?<T>(lease:import('@ubeeq/jobs').JobLease,operation:()=>Promise<T>):Promise<T>;
  withWebsitePolicy?<T>(workspaceId:string,subjectIds:readonly string[],operation:()=>Promise<T>):Promise<T>;
  withWebsiteMaintenance?<T>(operation:()=>Promise<T>):Promise<T>;
  assertWebsiteEffects?(workspaceId:string):Promise<void>;
  acceptWebsiteEffects?<T>(workspaceId:string,operation:(transaction:import('@ubeeq/persistence').PersistenceTransaction)=>Promise<T>):Promise<T>;
  hostingOAuthStates?:import('@ubeeq/integrations').OAuthStateStore;
  getPublicRendition?(workspaceId:string,source:string):Promise<{bytes:Uint8Array;width:number;height:number}|undefined>;
  putPublicRendition?(workspaceId:string,source:string,image:{bytes:Uint8Array;width:number;height:number}):Promise<void>;
}

export interface RegionalControlPlane {
  routingDirectory: RoutingDirectory;
  migrationCheckpoints: MigrationCheckpointStore;
  /** Omitted in read-only cell runtimes; migrations execute in a dedicated control-plane worker. */
  orchestrator?: MigrationOrchestrator;
}

/** Trusted construction context. Local vault is the actual runtime-owned
 * encrypted adapter, never a memory fallback or a caller-selected credential. */
export interface ReferenceCommerceCompositionContext {
 adapters:ReferenceAdapterSet;instanceId:string;cellId:string;region:string;publicBaseUrl:string;
 local?:{configuration:Readonly<LocalAdapterConfiguration>;vault:import('@ubeeq/integrations').CredentialVault};
}
export interface ReferenceCommerceComposition {
 configuration:ReferenceCommerceConfiguration;
 dependencies?:Pick<ReferenceCommerceDependencies,'subject'|'customerSubject'|'customerCredential'|'creator'>;
}
/** The exact configured instances that Core itself mounts and executes. */
export interface ReferenceWebsiteRuntime {
 service:WebsiteService|undefined;persistence:RuntimeWebsitePersistence|undefined;publishing:WebsitePublishingService|undefined;
 hostingConnections:WebsiteHostingConnections|undefined;hostingAdapters:readonly import('@ubeeq/core').WebsiteHostingAdapter[];
}
/** Host-owned hosting infrastructure composed with the same credential vault,
 * durable OAuth states and current authorization policy as its website service.
 * Native adapters are the exact objects included in adapters, so the HTTP
 * serving routes and publishing worker share one deployment implementation. */
export interface ReferenceWebsiteHostingInfrastructure {
 readonly connections?:WebsiteHostingConnections;
 readonly adapters:readonly import('@ubeeq/core').WebsiteHostingAdapter[];
 readonly nativeAdapters:readonly NativeWebsiteHostingAdapter[];
}
export interface ReferenceWebsiteServiceCompositionContext {
 readonly adapters:ReferenceAdapterSet;
 readonly persistence:RuntimeWebsitePersistence|undefined;
}
export interface ReferenceWebsiteHostingCompositionContext extends ReferenceWebsiteServiceCompositionContext {
 readonly service:WebsiteService|undefined;
}
export interface ReferenceWebsitePublishingCompositionContext extends ReferenceWebsiteHostingCompositionContext {
 readonly hostingConnections:WebsiteHostingConnections|undefined;
 readonly hostingAdapters:readonly import('@ubeeq/core').WebsiteHostingAdapter[];
}
/** Preparation is composed after the actual website and Commerce services, so
 * a host can bind connected publishing without a second runtime or inventory. */
export interface ReferenceContentPreparationContext {
 adapters:ReferenceAdapterSet;hostPorts:HostExtensionRuntimePorts;instanceId:string;cellId:string;region:string;
 website:Readonly<ReferenceWebsiteRuntime>;commerce:ReturnType<typeof createReferenceCommerce>|undefined;
}
export interface ReferenceApiConfiguration extends Partial<LocalAdapterConfiguration> {
  /** Retained host supplies its real store, services and feature drivers. Core
   * resolves the verified creator session before reading request input. */
  contentPreparation?: (context:ReferenceContentPreparationContext)=>ContentPreparationRuntimeBindings;

  commerce?: ReferenceCommerceConfiguration;
  /** Synchronous trusted configuration using the actual already-created adapters.
   * Core creates, exposes and closes exactly one resulting Commerce runtime.
   * Cannot be combined with legacy direct commerce configuration. */
  configureCommerce?:(context:ReferenceCommerceCompositionContext)=>ReferenceCommerceComposition|undefined;
  registrationAdmission?: (input: { email: string; invitationCode?: string; organizationName?: string }) => Promise<{ allowed: boolean; reasonCode?: string }>;
  /** Trusted host preparation is database-only and atomic with Creator creation.
   * Activation runs after commit and must be idempotent; a deferred activation
   * returns the persisted Creator with an honest pending state for worker recovery.
   */
  creatorLifecycle?: {
    prepare(input: { creator: Readonly<CreatorRecord>; actorUserId: string; repositories: UbeeqRepositories; transaction: import('@ubeeq/persistence').PersistenceTransaction }): Promise<void>;
    activate?(input: { creator: Readonly<CreatorRecord>; actorUserId: string }): Promise<{ state: 'ready' | 'pending' }>;
  };
  /** Trusted hosts must recheck current member authority with commit-time guards
   * in this transaction. Without an adapter, only the Creator's current owner
   * can mutate collections; an earlier role lookup cannot authorize a commit. */
  collectionAuthorization?: {
    /** Optional current host policy for collection reads and displayed editing
     * capabilities. This does not replace the accepting transaction guard below.
     * An omitted resolver retains the neutral role-based behavior. */
    resolveCapabilities?(input:{creator:Readonly<CreatorRecord>;actorUserId:string;repositories:UbeeqRepositories}):Promise<{canRead:boolean;canEdit:boolean}>;
    authorizeMutation(input:{creator:Readonly<CreatorRecord>;actorUserId:string;repositories:UbeeqRepositories;transaction:import('@ubeeq/persistence').PersistenceTransaction}):Promise<void>;
  };
  /** Current actor authority must join the actual Work transaction, including
   * receipt recovery. A true result retains Creator and membership guards until
   * commit. Without a host adapter, only the current Creator owner can write. */
  workAuthorization?: {
    authorizeMutation(input:{creator:Readonly<CreatorRecord>;actorUserId:string;repositories:UbeeqRepositories;transaction:import('@ubeeq/persistence').PersistenceTransaction}):Promise<boolean>;
  };

  publicBaseUrl: string;
  instanceId?: string;
  cellId?: string;
  region?: string;
  operator?: string;
  federationPolicy?: FederationPolicy;
  federationVerifier?: FederationSignatureVerifier;
  mediaProcessor?: MediaProcessor;
  /** Host-selected lease for bounded native decoding; defaults to 60 seconds. */
  processingLeaseSeconds?: number;
  adapters?: ReferenceAdapterSet;
  /** Explicit transfer of this actual injected set's resource lifetime only.
   * Omitted/host preserves caller ownership. Runtime requires its real close. */
  adapterOwnership?:'host'|'runtime';
  /** Trusted synchronous local composition before the concrete local constructor.
   * The returned set remains runtime-owned, including SQLite defaults and close.
   * Cannot be combined with the host-owned generic adapters path. */
  createLocalAdapters?: (configuration:LocalAdapterConfiguration)=>ReturnType<typeof createLocalAdapterSet>;
  regionalControlPlane?: RegionalControlPlane;
  tenancy?: TenancyAndAccessPort;
  hostPorts?: HostExtensionRuntimePorts | ((adapters: ReferenceAdapterSet) => HostExtensionRuntimePorts);
  /** Require original/output receipts, physical closure and durable quota fencing. */
  requireUploadAccounting?:boolean;
  tenancyMode?: "single_operator" | "multi_tenant_saas";
  /** Product/deployment supplies this requirement; the neutral reference defines no operator role hierarchy. */
  operatorAuthorization?: AuthorizationRequirement;
  diagnostics?: readonly DependencyDiagnostic[];
  /** Optional host-composed deterministic activity interface; no LLM service. */
  /** Trusted product composition may supply catalogue/rendition and policy ports. */
  websiteService?: WebsiteService|((context:ReferenceWebsiteServiceCompositionContext)=>WebsiteService);
  websitePersistence?: RuntimeWebsitePersistence | ((context:{adapters:ReferenceAdapterSet;blobs?:WebsiteBlobStore})=>RuntimeWebsitePersistence);
  websiteHostingAdapters?:readonly import('@ubeeq/core').WebsiteHostingAdapter[];
  websitePreviewMaxFileBytes?:number;
  websitePublishing?: WebsitePublishingService|((context:ReferenceWebsitePublishingCompositionContext)=>WebsitePublishingService);
  /** Complete host-composed infrastructure. A trusted synchronous factory may
   * use the actual adapters, persistence and service after their construction.
   * Core uses the exact returned instances throughout HTTP and worker handling. */
  websiteHostingInfrastructure?:Readonly<ReferenceWebsiteHostingInfrastructure>|((context:ReferenceWebsiteHostingCompositionContext)=>Readonly<ReferenceWebsiteHostingInfrastructure>);
  nativeWebsiteProfiles?: readonly NativeWebsiteHostingProfile[];
  /** Explicit outbound policy is required before any external hosting connection is enabled. */
  websiteHostingExternal?:{authorizeUrl:(url:URL)=>Promise<void>;authorizeSftpHost:(host:string,port:number)=>Promise<void>;netlify?:{clientId:string;redirectUri:string}};
  activityCommands?: { execute(principal: { actorId: string; profileId: string }, input: string): Promise<string> };
}

/** Shared process configuration for the reference API and its local worker. */
export const referenceApiConfigurationFromEnvironment = (environment: NodeJS.ProcessEnv = process.env): ReferenceApiConfiguration => {
  const port = Number(environment.PORT ?? 4100);
  const dataDirectory = environment.UBEEQ_DATA_DIRECTORY ?? "./var/reference";
  return {
    databasePath: environment.UBEEQ_DATABASE_PATH ?? `${dataDirectory}/ubeeq.sqlite`,
    dataDirectory,
    publicBaseUrl: environment.UBEEQ_PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
    websitePreviewMaxFileBytes:environment.UBEEQ_WEBSITE_PREVIEW_MAX_FILE_BYTES===undefined?undefined:Number(environment.UBEEQ_WEBSITE_PREVIEW_MAX_FILE_BYTES),
    instanceId: environment.UBEEQ_INSTANCE_ID,
    cellId: environment.UBEEQ_CELL_ID ?? "local-single-cell",
    region: environment.UBEEQ_CELL_REGION ?? "local",
    operator: environment.UBEEQ_CELL_OPERATOR ?? "self-hosted",
    credentialEncryptionKey: environment.UBEEQ_CREDENTIAL_ENCRYPTION_KEY,
    commerce: referenceCommerceConfigurationFromEnvironment(environment),
    nativeWebsiteProfiles:environment.UBEEQ_WEBSITE_HOSTING_ROOT&&environment.UBEEQ_WEBSITE_HOSTING_URL_TEMPLATE?[{id:'local',root:environment.UBEEQ_WEBSITE_HOSTING_ROOT,publicUrlTemplate:environment.UBEEQ_WEBSITE_HOSTING_URL_TEMPLATE,persistent:true,writerMode:'single'}]:[],
  };
};

export const createReferenceApi = (configuration: ReferenceApiConfiguration): { commerce?:ReturnType<typeof createReferenceCommerce>; website:Readonly<ReferenceWebsiteRuntime>; server: Server; handle(request: IncomingMessage, response: ServerResponse): Promise<void>; runNextJob(workerId: string): Promise<unknown>; resolveConnectorAppCredentials(input: { actorUserId: string; creatorId: string; provider: string }): ReturnType<HostExtensionRuntimePorts["connectorAppCredentials"]["resolveOAuthClient"]>; runOperation<Result>(operation:()=>Promise<Result>):Promise<Result>; close(): Promise<void> } => {
  if(configuration.configureCommerce!==undefined&&(typeof configuration.configureCommerce!=='function'||configuration.commerce!==undefined))throw new Error('Configure one trusted Commerce composition or direct Commerce configuration.');
  if(configuration.createLocalAdapters!==undefined){
    if(typeof configuration.createLocalAdapters!=='function')throw new Error('Local adapter creation requires a trusted factory.');
    if(configuration.adapters!==undefined)throw new Error('Choose either runtime-owned local adapter creation or host-owned adapters.');
  }
  if(configuration.adapterOwnership!==undefined&&!['host','runtime'].includes(configuration.adapterOwnership)||configuration.adapterOwnership==='runtime'&&(!configuration.adapters||typeof configuration.adapters.close!=='function'))throw new Error('Runtime adapter ownership requires the actual injected set and its concrete close operation.');
  const cellId = configuration.cellId ?? "local-single-cell";
  const region = configuration.region ?? "local";
  const processingLeaseSeconds=configuration.processingLeaseSeconds??60;
  if(!Number.isSafeInteger(processingLeaseSeconds)||processingLeaseSeconds<30||processingLeaseSeconds>900)throw new Error('Processing leases must be between 30 and 900 seconds.');
  const cellOwned = { homeCellId: cellId, dataHomeRegion: region, dataHomeAssignedAt: new Date().toISOString(), routingRevision: 1 };
  const dataHomeOf = (record: Pick<CreatorRecord, "homeCellId" | "dataHomeRegion" | "dataHomeAssignedAt" | "routingRevision">) => ({ homeCellId: record.homeCellId, dataHomeRegion: record.dataHomeRegion, dataHomeAssignedAt: record.dataHomeAssignedAt, routingRevision: record.routingRevision });
  const localConfiguration: LocalAdapterConfiguration = {
    databasePath: configuration.databasePath ?? "./var/reference/ubeeq.sqlite",
    dataDirectory: configuration.dataDirectory ?? "./var/reference",
    publicBaseUrl: configuration.publicBaseUrl,
    cellId,
    sessionTtlSeconds: configuration.sessionTtlSeconds,
    credentialEncryptionKey: configuration.credentialEncryptionKey,
  };
  const localAdapters = configuration.adapters ? undefined : (configuration.createLocalAdapters ?? createLocalAdapterSet)(localConfiguration);
  const adapters: ReferenceAdapterSet = configuration.adapters ?? {
    repositories: localAdapters!.repositories, storage: localAdapters!.storage, uploads: localAdapters!.storage,
    delivery: localAdapters!.storage, jobs: localAdapters!.jobs, identity: localAdapters!.identity,
    localIdentity: localAdapters!.identity, federation: localAdapters!.federation, credentials: localAdapters!.credentials,
  };
  try{
  const composition = composeReferenceApplication({
    instanceId: configuration.instanceId ?? "local-reference",
    cell: { id: cellId, region, operator: configuration.operator ?? "self-hosted" },
    publicBaseUrl: configuration.publicBaseUrl,
    extensions: [], requiredExtensions: {},
    ...(configuration.adapters ? {} : { localAdapter: { sqliteDatabasePath: localConfiguration.databasePath, storageDirectory: localConfiguration.dataDirectory } })
  }, {
    identity: adapters.identity, repositories: adapters.repositories, objectStorage: adapters.storage, delivery: adapters.delivery, jobs: adapters.jobs,
    diagnostics: configuration.diagnostics ?? [{ name: configuration.adapters ? "persistence" : "sqlite", check: async () => { await adapters.repositories.creators.list({ limit: 1 }); return { status: "ok" as const }; } }]
  });
  const { repositories } = composition.dependencies;
  const processor = configuration.mediaProcessor ?? new LocalImageProcessor();

  const session = async (request: IncomingMessage, allowCustomer = false) => {
    const credential = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!credential || credential === request.headers.authorization) throw new HttpError(401, "authentication_required", "A bearer session is required");
    const verified = await adapters.identity.verifySession({ credential });
    if (!verified) throw new HttpError(401, "authentication_invalid", "The session is invalid or expired");
    if (!allowCustomer && (verified.subject.accountScope === 'customer_account' || verified.subject.roles.includes('customer_account'))) throw new HttpError(403, 'creator_access_denied', 'Customer accounts do not have creator access.');
    return verified;
  };
  const operatorSession = async (request: IncomingMessage) => {
    if (!configuration.operatorAuthorization || !Object.values(configuration.operatorAuthorization).some(values => values?.length)) throw new HttpError(404, "operations_unavailable", "Operator operations are not configured");
    const authenticated = await session(request);
    requireAuthorization(authenticated.subject, configuration.operatorAuthorization);
    return authenticated;
  };
  const regionalControl = (): RegionalControlPlane => {
    if (!configuration.regionalControlPlane) throw new HttpError(503, "regional_control_unavailable", "This cell is not configured with a managed routing control plane");
    return configuration.regionalControlPlane;
  };
  const getDistinctOperatorUserIds = async (): Promise<string[]> => {
    const all = await allRecords(repositories.creators);
    const ids = new Set<string>();
    for (const c of all) if (c.subjectId) ids.add(c.subjectId);
    return [...ids];
  };

  const configuredHostPorts = typeof configuration.hostPorts === "function" ? configuration.hostPorts(adapters) : configuration.hostPorts;
  const tenancyMode = configuredHostPorts?.tenancyAndAccess.mode ?? configuration.tenancy?.mode ?? configuration.tenancyMode ?? "single_operator";

  const tenancy: TenancyAndAccessPort = configuredHostPorts?.tenancyAndAccess ?? configuration.tenancy ?? (
    tenancyMode === "multi_tenant_saas"
      ? {
          mode: "multi_tenant_saas" as const,
          async assertCanCreateCreatorUser() {},
          async assertCanCreateCustomerAccount() {},
          async listAccessibleCreatorIds(actorUserId: string) {
            const all = await allRecords(repositories.creators);
            return all.filter((c) => c.subjectId === actorUserId).map((c) => c.id);
          },
          async resolveCreatorRole(actorUserId: string, creatorId: string) {
            const creator = await repositories.creators.get(creatorId);
            return creator?.subjectId === actorUserId ? "owner" : null;
          },
          isContributorManagementEnabled: () => true,
          isOrganizationManagementEnabled: () => true
        }
      : new SingleOperatorTenancyAdapter({
          getOperatorUserId: async () => {
            const claim = await repositories.instanceOperators?.get(configuration.instanceId ?? 'local-reference');
            if (claim) return claim.actorId;
            const all = await allRecords(repositories.creators);
            if (!all.length) return null;
            all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            return all[0]?.subjectId ?? null;
          },
          countCreatorUsers: async () => (await getDistinctOperatorUserIds()).length,
          listOperatorCreatorIds: async (operatorId) => {
            const all = await allRecords(repositories.creators);
            return all
              .filter((c) => c.subjectId === operatorId)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map((c) => c.id);
          }
        })
  );

  const hostPorts = configuredHostPorts ?? createDefaultOpenCorePorts({ tenancyAndAccess: tenancy });
  const usageOutbox = repositories.hostRecords ? new UsageSettlementOutbox(repositories, hostPorts.usageQuota, configuration.instanceId ?? 'local-reference', cellId) : undefined;
  const uploadAccountingAvailable=Boolean(repositories.hostRecords && adapters.uploads.seal && hostPorts.usageQuota.closeStorageReservation);
  if(configuration.requireUploadAccounting && !uploadAccountingAvailable){localAdapters?.database.close();throw new Error('Physical upload closure and terminal storage quota reservations are required.');}
  const uploadAccounting=uploadAccountingAvailable ? {quota:hostPorts.usageQuota,usageOutbox:usageOutbox!,closureOutbox:new StorageClosureOutbox(repositories,hostPorts.usageQuota,configuration.instanceId??'local-reference',cellId)} : undefined;
  const uploadLifecycle = repositories.hostRecords ? new UploadLifecycle(repositories,adapters.uploads,adapters.jobs,configuration.instanceId ?? 'local-reference',cellId,configuration.publicBaseUrl,uploadAccounting) : undefined;
  const ownedObjectWrites = uploadAccounting && adapters.uploads.recoverCompletion ? new OwnedObjectWrites(repositories,adapters.uploads,hostPorts.usageQuota,configuration.instanceId ?? 'local-reference',cellId) : undefined;
  if(configuration.requireUploadAccounting && !ownedObjectWrites){localAdapters?.database.close();throw new Error('Recoverable physical output writes are required.');}
  const processingUsageKey = (asset: AssetRecord) => (asset as AssetRecord & { processingUsageKey?: string }).processingUsageKey ?? `asset-processing:${asset.id}:${asset.objectVersion}`;
  const deferUsage = async (intent: import('@ubeeq/persistence').HostRecord) => {
    try { await usageOutbox!.deliver(intent); }
    catch { await audit({ action: 'usage.settlement_deferred', subjectId: intent.scopeId, payload: { settlementId: intent.id } }); }
  };

  const resolveRequestCreatorId = (request: IncomingMessage, url: URL): string | undefined => {
    const headerId = request.headers["x-creator-id"];
    if (typeof headerId === "string" && headerId.trim()) return headerId.trim();
    const queryId = url.searchParams.get("creatorId");
    if (queryId && queryId.trim()) return queryId.trim();
    return undefined;
  };

  const creatorFor = async (subjectId: string, requestedCreatorId?: string): Promise<CreatorRecord> => {
    const accessibleIds = await tenancy.listAccessibleCreatorIds(subjectId);
    if (!accessibleIds.length) {
      throw new HttpError(403, "creator_access_denied", "This account does not have creator access in this instance.");
    }

    if (requestedCreatorId) {
      if (!accessibleIds.includes(requestedCreatorId)) {
        throw new HttpError(403, "creator_not_accessible", "The requested creator identity does not belong to your account.");
      }
      const selected = await repositories.creators.get(requestedCreatorId);
      if (selected) return selected;
      throw new HttpError(404, "creator_not_found", "The selected creator was not found");
    }

    const defaultCreator = await repositories.creators.get(accessibleIds[0]);
    if (defaultCreator) return defaultCreator;
    throw new HttpError(404, "creator_not_found", "No creator profile belongs to the current subject");
  };
  const requireCompactContent=(creator:CreatorRecord)=>{
    if(creator.contentAuthority==='retained-v1')throw new HttpError(503,'retained_content_routes_unavailable','This Creator requires the retained content routes.');
  };
  const ownedWork = async (workId: string, subjectId: string, requestedCreatorId?: string, access: "read" | "edit" = "edit"): Promise<WorkRecord> => {
    const work = await repositories.works.get(workId);
    if (!work) throw new HttpError(404, "work_not_found", "Work was not found");
    const creator = await creatorFor(subjectId, requestedCreatorId ?? work.creatorId);
    requireHomeCell({ cellId }, creator);
    await requireCreatorWritable(creator);
    requireHomeCell({ cellId }, work);
    const role = await tenancy.resolveCreatorRole(subjectId, creator.id);
    if (!role || (access === 'edit' && !['owner', 'admin', 'editor'].includes(role))) throw new HttpError(403, 'creator_access_denied', 'Creator access is required.');
    if (work.creatorId !== creator.id) throw new HttpError(403, "work_not_owned", "Work does not belong to the current creator");
    if (work.dataHomeRegion !== creator.dataHomeRegion || work.routingRevision !== creator.routingRevision) throw new HttpError(409, "data_home_mismatch", "Work and creator data homes do not match");
    return work;
  };
  /** A migration source hold is a data-home safety control, not product moderation policy. */
  const requireCreatorWritable = async (creator: CreatorRecord): Promise<void> => {
    const hold = (await repositories.moderationHolds.list({ limit: 100 })).items.find((value) => value.subjectId === creator.id && value.state === "active" && value.reason?.startsWith("migration:"));
    if (hold) throw new HttpError(409, "migration_source_held", "Creator writes are paused while a regional migration is in progress");
  };
  const authorizeWorkMutation=async(creatorId:string,actorUserId:string,expected:Pick<CreatorRecord,'instanceId'|'homeCellId'|'dataHomeRegion'|'dataHomeAssignedAt'|'routingRevision'>,transaction:import('@ubeeq/persistence').PersistenceTransaction):Promise<void>=>{
    const current=await repositories.creators.get(creatorId,{transaction});
    if(!current||current.instanceId!==(configuration.instanceId??'local-reference')||current.instanceId!==expected.instanceId
      ||current.homeCellId!==cellId||current.homeCellId!==expected.homeCellId||current.dataHomeRegion!==region||current.dataHomeRegion!==expected.dataHomeRegion
      ||current.routingRevision!==expected.routingRevision||current.dataHomeAssignedAt!==expected.dataHomeAssignedAt
      ||'deletion' in current&&current.deletion||'status' in current&&current.status!==undefined&&current.status!=='active')throw new HttpError(403,'work_edit_denied','Current Work editing access is required.');
    if(configuration.workAuthorization){
      if(!await configuration.workAuthorization.authorizeMutation({creator:Object.freeze({...current}),actorUserId,repositories,transaction}))throw new HttpError(403,'work_edit_denied','Current Work editing access is required.');
    }else{
      if(current.subjectId!==actorUserId)throw new HttpError(403,'work_edit_denied','Current Work editing access is required.');
      if(!repositories.creators.checkRevision)throw new Error('Work mutations require commit-time authority guards.');
      await repositories.creators.checkRevision(current.id,current.revision,{transaction});
    }
  };
  const requireSnapshot=async<T>(repository:{snapshot?:()=>Promise<import('@ubeeq/persistence').RepositorySnapshot<T>>})=>{
    if(!repository.snapshot)throw new HttpError(503,'publication_authority_unavailable','Publication requires a complete, guarded content inventory.');
    return repository.snapshot();
  };
  const preparePublicationCommit=async()=>{
    if(!repositories.assets.snapshot)throw new HttpError(503,'publication_authority_unavailable','Publication requires a complete, guarded source inventory.');
    const snapshots:import('@ubeeq/persistence').RepositorySnapshot<unknown>[]=[await requireSnapshot(repositories.moderationHolds)];
    // Commercial membership, organizations, approvals and evidence share this
    // authority. Guard absence as well as every existing record, without a GSI.
    if(repositories.hostRecords)snapshots.push(await requireSnapshot(repositories.hostRecords));
    return async(transaction:import('@ubeeq/persistence').PersistenceTransaction)=>{
      for(const snapshot of snapshots)await snapshot.bind(transaction);
    };
  };
  const authorizePublicationCommit=async(work:WorkRecord,assets:readonly AssetRecord[],actorId:string,transaction:import('@ubeeq/persistence').PersistenceTransaction):Promise<void>=>{
    await authorizeWorkMutation(work.creatorId,actorId,work,transaction);
    for(const asset of assets){
      if(asset.instanceId!==work.instanceId||asset.creatorId!==work.creatorId||asset.workId!==work.id
        ||asset.homeCellId!==work.homeCellId||asset.dataHomeRegion!==work.dataHomeRegion
        ||asset.routingRevision!==work.routingRevision||asset.dataHomeAssignedAt!==work.dataHomeAssignedAt){
        throw new HttpError(409,'publication_source_scope_mismatch','Every publication source must belong to the current Work and data home.');
      }
    }
  };
  const audit = async (input: { action: string; actorId?: string; subjectId?: string; payload?: Record<string, unknown> }): Promise<void> => {
    await repositories.auditEvents.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", ...cellOwned, action: input.action, actorId: input.actorId, subjectId: input.subjectId, payload: input.payload ?? {} });
  };
  const requireClearAdmission = async (operation: string, subjectIds: readonly string[]): Promise<void> => {
    const holds: ReviewHold[] = [];
    const subjects = new Set(subjectIds);
    for await (const hold of repositoryItems(request => repositories.moderationHolds.list(request))) {
      if (hold.state === 'active' && subjects.has(hold.subjectId)) holds.push({ id: hold.id, cellId: hold.homeCellId, subjectId: hold.subjectId, active: true, sourceId: hold.id, reasonCode: hold.reason ?? 'review_hold', createdAt: hold.createdAt });
    }
    requireAdmission(subjectIds.map((subjectId) => ({ subjectId })), holds, operation);
  };
  const collectionContext=async(actorId:string,creator:CreatorRecord,write=false)=>{
    requireHomeCell({cellId},creator);
    if(creator.instanceId!==(configuration.instanceId??'local-reference')||creator.dataHomeRegion!==region)throw new HttpError(404,'creator_not_found','Creator not found.');
    const role=await tenancy.resolveCreatorRole(actorId,creator.id);
    if(!role)throw new HttpError(403,'collection_edit_denied','Current collection access is required.');
    const legacyCanEdit=['owner','admin','editor'].includes(role);
    let canRead=true,canEdit=legacyCanEdit;
    if(configuration.collectionAuthorization?.resolveCapabilities!==undefined){
      if(typeof configuration.collectionAuthorization.resolveCapabilities!=='function')throw new HttpError(503,'collection_capabilities_unavailable','Current collection capabilities are unavailable.');
      let capabilities:{canRead:boolean;canEdit:boolean};
      try{capabilities=await configuration.collectionAuthorization.resolveCapabilities({creator:Object.freeze(structuredClone(creator)),actorUserId:actorId,repositories});}
      catch{throw new HttpError(503,'collection_capabilities_unavailable','Current collection capabilities are unavailable.');}
      if(!capabilities||typeof capabilities!=='object'||Array.isArray(capabilities)||typeof capabilities.canRead!=='boolean'||typeof capabilities.canEdit!=='boolean'||capabilities.canEdit&&!capabilities.canRead)throw new HttpError(503,'collection_capabilities_unavailable','Current collection capabilities are unavailable.');
      canRead=capabilities.canRead;canEdit=capabilities.canEdit;
    }
    if(!canRead||write&&!canEdit)throw new HttpError(403,'collection_edit_denied','Current collection access is required.');
    if(write)await requireCreatorWritable(creator);
    if(!repositories.hostRecords)throw new HttpError(503,'collection_management_unavailable','Durable collection storage is required.');
    const scope={instanceId:creator.instanceId,cellId,region};
    const store=new RepositoryCreatorCollectionStore(repositories,scope,async(current,transaction)=>{
      if(configuration.collectionAuthorization)await configuration.collectionAuthorization.authorizeMutation({creator:Object.freeze({...current}),actorUserId:actorId,repositories,transaction});
      else{
        if(current.subjectId!==actorId)throw new CreatorCollectionError('access_denied','Current owner authority is required.');
        if(!repositories.creators.checkRevision)throw new Error('Collection mutations require commit-time authority guards.');
        await repositories.creators.checkRevision(current.id,current.revision,{transaction});
      }
    });
    return{store,canEdit:canRead&&canEdit&&Boolean(configuration.collectionAuthorization||creator.subjectId===actorId),service:new CreatorCollectionService(store,async requested=>requested.tenantId===creator.instanceId&&requested.creatorId===creator.id)};
  };
  const collectionFields=(body:Record<string,unknown>,allowed:readonly string[])=>{
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowed.includes(key)))throw new HttpError(400,'invalid_request','Collection request contains unsupported fields.');
  };
  const collectionRevision=(body:Record<string,unknown>)=>{
    if(!body||!Number.isSafeInteger(body.revision)||(body.revision as number)<1)throw new HttpError(400,'invalid_request','A current collection revision is required.');
    return body.revision as number;
  };
  const collectionView=(collection:RuntimeCollection,workIds:readonly string[])=>{
    // Keep opaque legacy fields in persistence; only documented editing fields
    // are returned from this management endpoint.
    const {id:recordId,creatorId:owner,title,description,type,visibility,slug,slugHistory,status,coverAssetId,createdAt,updatedAt,revision,managementReady,archivedAt,deletedAt,workPublicationHistoryAt}=collection;
    return{id:recordId,creatorId:owner,title,description,type,visibility,slug,slugHistory,status,coverAssetId,createdAt,updatedAt,revision,managementReady,archivedAt,deletedAt,workPublicationHistoryAt,workIds};
  };
  const collectionResult=async(context:Awaited<ReturnType<typeof collectionContext>>,creatorId:string,id:string)=>{
    const collection=await context.service.get(configuration.instanceId??'local-reference',id);
    if(collection.creatorId!==creatorId)throw new HttpError(404,'collection_not_found','Collection not found.');
    return{...collectionView(collection,(await context.store.listCollectionWorks(collection.tenantId,id)).map(m=>m.workId)),permissions:{canEdit:context.canEdit&&collection.managementReady&&collection.status!=='deleted'}};
  };
  const existingImportIds = async () => ({ publication: (await allRecords(repositories.publications)).map(({ id }) => id), publicationIntent: (await allRecords(repositories.publicationIntents)).map(({ id }) => id), moderationEvidence: (await allRecords(repositories.moderationEvidence)).map(({ id }) => id), moderationHold: (await allRecords(repositories.moderationHolds)).map(({ id }) => id), reviewCase: (await allRecords(repositories.reviewCases)).map(({ id }) => id), auditEvent: (await allRecords(repositories.auditEvents)).map(({ id }) => id), usageEvent: (await allRecords(repositories.usageEvents)).map(({ id }) => id), integrationAccount: (await allRecords(repositories.integrationAccounts)).map(({ id }) => id) });
  const currentPublicWork = async (workId: string) => {
    const denied = () => new HttpError(404, 'work_not_found', 'Published work was not found');
    const work = await repositories.works.get(workId);
    if (!work || !['ready', 'published'].includes(work.status) || !await repositories.creators.get(work.creatorId)) throw denied();
    const assets: AssetRecord[] = [];
    for await (const asset of repositoryItems(request => repositories.assets.list(request))) {
      if (asset.workId === work.id && asset.creatorId === work.creatorId && asset.status === 'ready') assets.push(asset);
    }
    const publications = [];
    for await (const publication of repositoryItems(request => repositories.publications.list(request))) {
      if (publication.workId === work.id && publication.status === 'live') publications.push(publication);
    }
    if (!assets.length || !publications.length) throw denied();
    try { await requireClearAdmission('Public viewing', [work.id, work.creatorId, ...assets.map(asset => asset.id)]); }
    catch (error) { if (error instanceof AdmissionBlockedError) throw denied(); throw error; }
    return { work, assets, publications };
  };
  const websiteBlobs=ownedObjectWrites?new OwnedWebsiteBlobs(repositories,ownedObjectWrites,adapters.storage,configuration.instanceId??'local-reference',cellId,cellId,{beforeWrite:workspace=>websiteStore?.assertWebsiteEffects?.(workspace)??Promise.resolve(),accept:async(workspace,operation)=>websiteStore?.acceptWebsiteEffects?websiteStore.acceptWebsiteEffects(workspace,operation):operation()}):undefined;
  const suppliedWebsiteStore=typeof configuration.websitePersistence==='function'?configuration.websitePersistence({adapters,blobs:websiteBlobs}):configuration.websitePersistence;
  const localWebsiteStore=localAdapters&&!configuration.websiteService&&!suppliedWebsiteStore?new SqliteWebsiteStore(`${localConfiguration.dataDirectory}/websites.sqlite`,websiteBlobs):undefined;
  const websiteStore:RuntimeWebsitePersistence|undefined=suppliedWebsiteStore??localWebsiteStore;
  const websiteLimits={apiVersion:'1' as const,export:true,maxPages:2000,maxAssets:2000,maxBytes:256*1024*1024,deploymentAdapters:[]};
  const websiteSources=createWebsiteSourceReader(repositories,localAdapters?()=>JSON.stringify([
    localAdapters.database.database.prepare('PRAGMA data_version').get(),localAdapters.database.database.prepare('SELECT total_changes() AS changes').get()
  ]):undefined);
  const renditionFlights=new Map<string,Promise<{bytes:Uint8Array;width:number;height:number}>>();
  const renditionWaiters:Array<()=>void>=[];let activeRenditions=0;
  const websiteRendition=(asset:AssetRecord)=>{
    // Website pixels must come from the approved public presentation. Reading
    // the private original here would bypass the Creator's crop or watermark.
    const location=(asset as AssetRecord&{storage?:StoredObject}).storage;
    if(asset.instanceId!==(configuration.instanceId??'local-reference')||asset.homeCellId!==cellId||asset.status!=='ready'||!location||location.scope!=='public'||!location.versionId||!location.contentType.startsWith('image/')||!/^[a-f0-9]{64}$/.test(location.checksum??'')||!Number.isSafeInteger(location.byteLength)||location.byteLength<=0||location.byteLength>50*1024*1024)throw new WebsiteError('media_not_public','An immutable approved public image is required.');
    requireCreatorScopedObject(location.key,{cellId,creatorId:asset.creatorId});
    const reference=structuredClone(location),legacyRecipe=`website-jpeg-1600-v1:${asset.id}:${asset.checksum}`;
    const recipe='website-jpeg-1600-v2:'+createHash('sha256').update(JSON.stringify([asset.id,reference.bucket,reference.key,reference.versionId,reference.checksum])).digest('hex');
    const identity={creatorId:asset.creatorId,operation:'website.rendition',idempotencyKey:recipe};
    const key=asset.creatorId+':'+recipe,existing=renditionFlights.get(key);if(existing)return existing;
    const cached=async()=>{
      // Earlier blobs remain subject to the cutover inventory baseline. Reuse
      // one only when its original input was also the approved public bytes.
      const pinned=await websiteStore!.getPublicRendition?.(asset.creatorId,recipe);if(pinned)return pinned;
      const legacy=reference.checksum===asset.checksum?await websiteStore!.getPublicRendition?.(asset.creatorId,legacyRecipe):undefined;
      if(legacy)return legacy;
      const saved=await ownedObjectWrites?.recover(identity);if(!saved)return;
      const {width,height}=saved.metadata;
      if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||(width as number)<=0||(height as number)<=0||saved.object.scope!=='private'||saved.object.contentType!=='image/jpeg'||saved.object.byteLength>10*1024*1024)throw new WebsiteError('invalid_media','The saved website image needs recovery.');
      const loaded=await adapters.storage.get(saved.object);
      if(['bucket','key','versionId','contentType','byteLength','checksum','scope'].some(field=>loaded.object[field as keyof StoredObject]!==saved.object[field as keyof StoredObject])||loaded.body.byteLength!==saved.object.byteLength||websiteDigest(loaded.body)!==saved.object.checksum)throw new WebsiteError('invalid_media','The saved website image failed integrity verification.');
      return {bytes:loaded.body,width:width as number,height:height as number};
    };
    const value=(async()=>{
      const found=await cached();if(found)return found;
      if(activeRenditions>=2)await new Promise<void>(resolve=>renditionWaiters.push(resolve));else activeRenditions++;
      try{
        // Another worker/process may have populated the persistent cache while this operation waited.
        const ready=await cached();if(ready)return ready;
        const loaded=await adapters.storage.get(reference),bytes=loaded.body;
        if(['bucket','key','versionId','contentType','byteLength','checksum','scope'].some(field=>loaded.object[field as keyof StoredObject]!==reference[field as keyof StoredObject])||bytes.length!==reference.byteLength||websiteDigest(bytes)!==reference.checksum)throw new WebsiteError('invalid_media','The approved public image changed or failed integrity verification.');
        const {createCropSourcePreview}=await import('@ubeeq/media-sharp');
        const result=await createCropSourcePreview(bytes,{maxPreviewEdge:1600,maxOutputBytes:10*1024*1024}),clean={bytes:result.body,width:result.width,height:result.height};
        if(ownedObjectWrites)await ownedObjectWrites.write({...identity,home:dataHomeOf(asset),bucket:reference.bucket,kind:'renditions',scope:'private',contentType:'image/jpeg',body:clean.bytes,metadata:{width:clean.width,height:clean.height,sourceVersionId:reference.versionId,sourceChecksum:reference.checksum,recipe:'website-jpeg-1600-v2'}});
        else if(websiteStore!.putPublicRendition)await websiteStore!.putPublicRendition(asset.creatorId,recipe,clean);
        else throw new WebsiteError('website_rendition_storage_required','Persistent website image storage is required.');
        return clean;
      }finally{const next=renditionWaiters.shift();if(next)next();else activeRenditions--;}
    })();
    renditionFlights.set(key,value);void value.finally(()=>renditionFlights.delete(key)).catch(()=>{});return value;
  };
  const configuredWebsiteService=(()=>{try{
    const supplied=configuration.websiteService;
    const service=typeof supplied==='function'?supplied({adapters,persistence:websiteStore}):supplied;
    if(supplied!==undefined&&(!service||typeof service.get!=='function'||typeof service.execute!=='function'))throw new WebsiteError('invalid_website_service','Website composition must synchronously return its concrete service.');
    return service;
  }catch(error){localWebsiteStore?.close();localAdapters?.database.close();throw error;}})();
  const websites = configuredWebsiteService ?? (websiteStore ? new WebsiteService({
    store: websiteStore,
    previewMaxFileBytes:configuration.websitePreviewMaxFileBytes,
    creatorIdentityAllowed: async (actor, identityId) => identityId === actor.workspaceId,
    membership: async actor => {
      const creator = await repositories.creators.get(actor.workspaceId);
      if (!creator || creator.subjectId !== actor.actorId || creator.homeCellId !== cellId) return undefined;
      await requireCreatorWritable(creator);
      return { workspaceId: actor.workspaceId, userId: actor.actorId, role: 'owner', status: 'active' };
    },
    capabilities: async () => websiteLimits,
    resolveSnapshot: async (actor, website) => {
      const documents = [];
      let documentBytes=0;
      for (const id of new Set(website.pages.filter(p => p.state === 'ready').map(p => p.documentId))) {
        const document = await websiteStore!.getDocument(actor.workspaceId, id);
        if (!document) throw new WebsiteError('missing_document', 'Page document was not found.');
        documentBytes+=Buffer.byteLength(JSON.stringify(document));
        if(documentBytes>websiteLimits.maxBytes) throw new WebsiteError('quota_exceeded','Website source documents exceed the build byte budget.');
        documents.push(document);
      }
      const galleries: WebsiteGallery[] = [], assets: WebsitePublicAsset[] = [], dependencies: WebsiteDependency[] = [{ kind: 'policy', id: 'reference-public-release', revision: '1' }];
      const catalogue=await websiteSources(actor.workspaceId);
      const needed = new Set<string>([website.theme.settings.logoAssetId, website.theme.settings.faviconAssetId, ...website.pages.filter(p => p.state === 'ready').flatMap(p => [p.socialAssetId,p.coverAssetId,p.backgroundAssetId])].filter((id): id is string => Boolean(id)));
      for (const document of documents) {
        const pending = [...document.blocks];
        while (pending.length) { const block = pending.pop()!; if (block.assetId || block.fileId) needed.add(block.fileId ?? block.assetId!); if (block.children) pending.push(...block.children); }
      }
      for (const publicationId of website.galleryPublicationIds) {
        const publication = catalogue.publications.get(publicationId);
        if (!publication || publication.status !== 'live' || publication.destination !== 'local') throw new WebsiteError('publication_not_public', 'The reference website selects live local public publications. Connected/premium sources require their product snapshot adapter.');
        const current = catalogue.current(publication.workId);
        if (current.work.creatorId !== actor.workspaceId || !current.publications.some(p => p.id === publicationId)) throw new WebsiteError('foreign_reference', 'Selected publication is outside this personal workspace.');
        // The reference public API defines its local presentation as all current ready assets.
        // Product adapters with multiple presentations must supply their narrower exact selection.
        const ids = current.assets.map(a => a.id);
        ids.forEach(id => needed.add(id));
        galleries.push({ publicationId, workId: current.work.id, workspaceId: actor.workspaceId, revision: publication.revision,
          title: current.work.title, slug: normalizeContentSlug(current.work.title, { fallback: 'gallery' }),
          tags: [], collectionIds: [], date: current.work.updatedAt, premium: false, previewAssetIds: ids.slice(0, 1), publicAssetIds: ids });
        if(!dependencies.some(dependency=>dependency.kind==='catalogue'&&dependency.id===current.work.id))dependencies.push({kind:'catalogue',id:current.work.id,revision:catalogue.revision(current.work.id)});
      }
      if (needed.size > websiteLimits.maxAssets) throw new WebsiteError('quota_exceeded', 'Too many public media references.');
      let totalBytes = 0;
      const resolved=await mapWebsiteSources([...needed],async id=>{
        const asset = catalogue.assets.get(id);
        if (!asset || !asset.workId || asset.creatorId !== actor.workspaceId || asset.status !== 'ready') throw new WebsiteError('media_not_public', 'Media must belong to a current public local presentation.');
        const current = catalogue.current(asset.workId);
        if (!current.publications.some(p => p.destination === 'local')) throw new WebsiteError('media_not_public', 'Media is not in an eligible public local publication.');
        if (!asset.mimeType.startsWith('image/')) throw new WebsiteError('public_rendition_adapter_required', 'The reference website adapter supports clean image renditions. Other public media requires an approved rendition adapter.');
        const clean=await websiteRendition(asset);
        totalBytes += clean.bytes.length;
        if (totalBytes > websiteLimits.maxBytes) throw new WebsiteError('quota_exceeded', 'Bundled media exceeds the website byte budget.');
        return {asset:{ id, workspaceId: actor.workspaceId, revision: asset.revision, checksum: websiteDigest(clean.bytes), mimeType: 'image/jpeg', bytes: clean.bytes,
          alt: current.work.title, width: clean.width, height: clean.height, approvedPublic: true, metadataStripped: true },work:current.work};
      });
      for(const result of resolved){assets.push(result.asset);if(!dependencies.some(dependency=>dependency.kind==='catalogue'&&dependency.id===result.work.id))dependencies.push({kind:'catalogue',id:result.work.id,revision:catalogue.revision(result.work.id)});}
      return { apiVersion: '1', website, documents, galleries, mappings: [], assets, dependencies };
    },
    evaluateRelease: async ({ actor, dependencies }) => {
      try { await requireClearAdmission('Website public release', [actor.workspaceId, ...dependencies.map(d => d.id)]); }
      catch (error) { if (error instanceof AdmissionBlockedError) return { decision: 'hold', revision: '1', reasons: ['active_hold'] }; throw error; }
      return { decision: 'allow', revision: '1', reasons: [] };
    },
    dependenciesEligible: async (actor, dependencies) => {
      try { await requireClearAdmission('Website eligibility', [actor.workspaceId, ...dependencies.map(d => d.id)]); }
      catch (error) { if (error instanceof AdmissionBlockedError) return false; throw error; }
      for(const dep of dependencies)if(dep.kind==='document'&&!await websiteStore!.getDocument(actor.workspaceId,dep.id))return false;
      return (await websiteSources(actor.workspaceId)).eligible(dependencies);
    },
    dependenciesCurrent:async(actor,dependencies)=>(await websiteSources(actor.workspaceId)).eligible(dependencies,true),
    enqueue: async payload => { await adapters.jobs.enqueue({ cellId, type: 'website.build', payload, idempotencyKey: payload.idempotencyKey, maxAttempts: 3 }); },
    audit: async event => { await audit({ action: event.action, actorId: event.actor.actorId, subjectId: event.websiteId, payload: { buildId: event.buildId, artifactDigest: event.artifactDigest, result: event.result } }); }
  }) : undefined);
  const nativeProfiles=configuration.nativeWebsiteProfiles??[];
  const hostingInfrastructure=(()=>{try{
    const supplied=configuration.websiteHostingInfrastructure;
    const infrastructure=typeof supplied==='function'?supplied({adapters,persistence:websiteStore,service:websites}):supplied;
    if(supplied!==undefined){
      if(!infrastructure||!Array.isArray(infrastructure.adapters)||!Array.isArray(infrastructure.nativeAdapters))throw new WebsiteError('invalid_hosting_infrastructure','Hosting composition must synchronously return concrete adapter collections.');
      if(infrastructure.nativeAdapters.some(adapter=>!infrastructure.adapters.includes(adapter)))throw new WebsiteError('hosting_adapter_mismatch','Native serving adapters must be the same instances used for publishing.');
      if(new Set(infrastructure.adapters.map(adapter=>adapter.id)).size!==infrastructure.adapters.length)throw new WebsiteError('duplicate_hosting_adapter','Each hosting adapter must have a unique identifier.');
    }
    return infrastructure;
  }catch(error){localWebsiteStore?.close();localAdapters?.database.close();throw error;}})();
  const nativeProbe=createHostingPublicProbe({authorizeUrl:async url=>{if(!nativeProfiles.some(p=>{const template=new URL(p.publicUrlTemplate.replace('{site}','a'.repeat(32)));return url.origin===template.origin;}))throw new WebsiteError('unsafe_probe','Public probe origin is outside the administrator profiles.');}});
  const nativeHosting=hostingInfrastructure?[...hostingInfrastructure.nativeAdapters]:nativeProfiles.map(p=>new NativeWebsiteHostingAdapter(p,nativeProbe));
  const authorizeHostingManager=async(actor:{workspaceId:string;actorId:string})=>{const creator=await repositories.creators.get(actor.workspaceId);if(!creator||creator.subjectId!==actor.actorId||creator.homeCellId!==cellId)throw new WebsiteError('authorization_denied','Current website owner authority is required.');await requireCreatorWritable(creator);};
  const external=configuration.websiteHostingExternal;
  if(external&&localAdapters&&!configuration.credentialEncryptionKey)throw new WebsiteError('hosting_vault_key_required','External hosting requires an explicit credential vault encryption key.');
  if(external&&websiteStore&&(!adapters.credentials||!websiteStore.hostingOAuthStates))throw new WebsiteError('hosting_credentials_required','External hosting requires a durable credential vault and OAuth state store.');
  const hostingConnections=hostingInfrastructure?hostingInfrastructure.connections:(external&&websiteStore?.hostingOAuthStates&&adapters.credentials?new WebsiteHostingConnections({cellId,vault:adapters.credentials,states:websiteStore.hostingOAuthStates,authorize:authorizeHostingManager,get:(w,id)=>websiteStore.getConnection(w,id),list:w=>websiteStore.listConnections(w),save:(c,r)=>websiteStore.saveConnection(c,r),netlify:external.netlify}):undefined);
  const externalProbe=external?createHostingPublicProbe({authorizeUrl:external.authorizeUrl}):undefined;
  const hostingAdapters:import('@ubeeq/core').WebsiteHostingAdapter[]=hostingInfrastructure?[...hostingInfrastructure.adapters]:[...nativeHosting,...configuration.websiteHostingAdapters??[]];
  if(!hostingInfrastructure&&hostingConnections&&externalProbe&&external&&websiteStore){
    const credential=(c:import('@ubeeq/core').HostingConnection)=>hostingConnections.credential(c);
    if(external.netlify)hostingAdapters.push(new NetlifyWebsiteHostingAdapter({credential,probe:externalProbe}));
    hostingAdapters.push(new CloudflarePagesWebsiteHostingAdapter({credential,probe:externalProbe}));
    for(const mode of ['pointer','in_place'] as const)hostingAdapters.push(new SftpWebsiteHostingAdapter(mode,{probe:externalProbe,connect:async(target,connection)=>connectWebsiteSftp({target,credential:JSON.parse(await credential(connection)),authorizeHost:external.authorizeSftpHost}),managedFiles:async target=>{
      const files=new Set<string>();for(const attempt of await websiteStore.listAttempts(target.workspaceId,target.websiteId)){if(attempt.targetId!==target.id||!attempt.artifactDigest)continue;const artifact=await websiteStore.getArtifact(target.workspaceId,attempt.artifactDigest);for(const file of artifact?.files.keys()??[])files.add(file);}return [...files];
    }}));
  }
  const websitePolicyActor='website-policy:'+cellId;
  const configuredWebsitePublishing=(()=>{try{
    const supplied=configuration.websitePublishing;
    const service=typeof supplied==='function'?supplied({adapters,persistence:websiteStore,service:websites,hostingConnections,hostingAdapters:Object.freeze([...hostingAdapters])}):supplied;
    if(supplied!==undefined&&(!service||typeof service.choices!=='function'||typeof service.execute!=='function'))throw new WebsiteError('invalid_website_publishing','Website composition must synchronously return its concrete publisher.');
    return service;
  }catch(error){localWebsiteStore?.close();localAdapters?.database.close();throw error;}})();
  const publishing=configuredWebsitePublishing??(websiteStore&&websites?new WebsitePublishingService({websites,store:websiteStore,artifacts:websiteStore,adapters:hostingAdapters,
    authorize:async(actor,action,target)=>{const creator=await repositories.creators.get(actor.workspaceId);if(actor.actorId===websitePolicyActor&&action==='publish'&&target&&creator?.homeCellId===cellId)return;if(!creator||creator.subjectId!==actor.actorId||creator.homeCellId!==cellId)throw new WebsiteError('authorization_denied','Current website owner authority is required.');await requireCreatorWritable(creator);},
    enqueue:async payload=>{await adapters.jobs.enqueue({cellId,type:'website.deploy',payload,idempotencyKey:payload.idempotencyKey,maxAttempts:20});},
    audit:async event=>{await audit({action:event.action,actorId:event.actor.actorId,subjectId:event.targetId??event.intentId??event.actor.workspaceId,payload:{generation:event.generation,digest:event.digest,result:event.result}});}
  }):undefined);
  let commerce:ReturnType<typeof createReferenceCommerce>|undefined;
  try{
  const commerceBinding=configuration.configureCommerce?.({adapters,instanceId:configuration.instanceId??'local-reference',cellId,region,publicBaseUrl:configuration.publicBaseUrl,...(localAdapters?{local:{configuration:Object.freeze({...localAdapters.database.configuration}),vault:localAdapters.credentials}}:{})});
  if(commerceBinding!==undefined&&(!commerceBinding||typeof commerceBinding!=='object'||!commerceBinding.configuration||typeof commerceBinding.configuration!=='object'||typeof (commerceBinding as unknown as {then?:unknown}).then==='function'))throw new Error('Commerce composition must synchronously return actual configuration.');
  if(commerceBinding?.dependencies&&Object.entries(commerceBinding.dependencies).some(([name,value])=>!['subject','customerSubject','customerCredential','creator'].includes(name)||value!==undefined&&typeof value!=='function'))throw new Error('Commerce authentication bindings require actual trusted functions.');
  const commerceConfiguration=commerceBinding?.configuration??configuration.commerce;
  if (commerceConfiguration && ((!localAdapters && !(commerceConfiguration.store && commerceConfiguration.vault)) || ((!commerceConfiguration.vault||commerceConfiguration.vault===localAdapters?.credentials) && (!localAdapters?.database.configuration.credentialEncryptionKey || localAdapters.database.configuration.credentialEncryptionKey.length < 32)))) throw new Error('Commerce requires a durable store and an encrypted vault; local vaults require an explicit encryption key of at least 32 characters.');
  commerce = commerceConfiguration ? createReferenceCommerce(commerceConfiguration, {
    deploymentId: configuration.instanceId ?? 'local-reference', cellId, publicBaseUrl: configuration.publicBaseUrl, dataDirectory: localConfiguration.dataDirectory,
    vault: commerceConfiguration.vault ?? localAdapters!.credentials, storage: adapters.storage, subject: async request => (await session(request, true)).subject.id,
    creator: async(subjectId,ownerId)=>{if(!ownerId)return creatorFor(subjectId);const creator=await repositories.creators.get(ownerId);if(!creator)throw new HttpError(404,'creator_not_found','Creator was not found.');
      if(creator.subjectId!==subjectId){const at=new Date().toISOString(),delegations=await adapters.identity.listDelegations({creatorId:ownerId,subjectId,at});
        if(!delegations.some(d=>d.creatorId===ownerId&&d.subjectId===subjectId&&(!d.expiresAt||d.expiresAt>at)&&d.scopes.includes('commerce.manage')))throw new HttpError(403,'creator_authorization_denied','Commerce management delegation is required.');}
      return creator;},
    publicCreator:async ownerId=>{const creator=await repositories.creators.get(ownerId);return creator?{displayName:creator.displayName,handle:creator.handle,bio:creator.bio}:undefined;},
    contentAvailable: async (ownerId, assetId) => !(await allRecords(repositories.moderationHolds)).some(h => h.state === 'active' && (h.subjectId === ownerId || h.subjectId === assetId)),
    ...commerceBinding?.dependencies,
    pruneCredentials: localAdapters&&!commerceConfiguration.vault ? (references,cutoff)=>localAdapters.credentials.pruneCommerceOrphans(references,cutoff) : undefined
  }) : undefined;
  }catch(error){localWebsiteStore?.close();localAdapters?.database.close();throw error;}
  const website:Readonly<ReferenceWebsiteRuntime>=Object.freeze({service:websites,persistence:websiteStore,publishing,hostingConnections,hostingAdapters:Object.freeze([...hostingAdapters])});
  const {preparationBindings,contentPreparation,retainedSources}=(()=>{
   try{
    const preparationBindings=configuration.contentPreparation?.({adapters,hostPorts,instanceId:composition.configuration.instanceId,cellId,region,website,commerce});
    if(preparationBindings && typeof preparationBindings.runNextJob!=='function'){
      throw Error('Content preparation HTTP requires its durable recovery and release worker.');
    }
    if(preparationBindings?.createCreator!==undefined&&typeof preparationBindings.createCreator!=='function'){throw Error('Retained Creator birth requires a trusted factory.');}
    if(preparationBindings?.prepareCreatorCreation!==undefined&&(typeof preparationBindings.prepareCreatorCreation!=='function'||preparationBindings.createCreator!==undefined)){throw Error('Retained Creator birth requires one trusted writer or pre-transaction preparation.');}
    const contentPreparation=preparationBindings?createContentPreparationNodeHandler({...preparationBindings,access:async(request,response,creatorId)=>{
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(creatorId)||!await tenancy.resolveCreatorRole(request.session.subject.id,creatorId))return false;
      return preparationBindings.access(request,response,creatorId);
    }},request=>session(request),{publicBaseUrl:configuration.publicBaseUrl}):undefined;
    const retainedSources=preparationBindings?.sourceFiles?createRetainedSourceFileNodeHandler(preparationBindings.sourceFiles,request=>session(request),{publicBaseUrl:configuration.publicBaseUrl}):undefined;
    return {preparationBindings,contentPreparation,retainedSources};
   }catch(error){commerce?.close();localWebsiteStore?.close();localAdapters?.database.close();throw error;}
  })();
  let lastWebsitePolicyScan=0;
  let commerceTurn=true;
  const runCoreJob = async (workerId: string) => {
    if (uploadLifecycle) try { await uploadLifecycle.repair(); } catch { await audit({ action:'upload.queue_repair_deferred',subjectId:cellId }); }
    if (ownedObjectWrites) try { await ownedObjectWrites.repair(); } catch { await audit({action:'storage.output_repair_deferred',subjectId:cellId}); }
    if (usageOutbox) try { await usageOutbox.recoverTerminal(adapters.jobs); await usageOutbox.drain(); } catch { await audit({ action: 'usage.settlement_retry_deferred', subjectId: cellId }); }
    if (commerce && commerceTurn) { commerceTurn=false; const job = await commerce.runNextJob(workerId); if (job) return job; }
    commerceTurn=true;
    // Recover policy changes from authoritative hold records, even if the process crashed after the hold committed.
    if(publishing&&websiteStore&&!configuration.websitePublishing&&Date.now()-lastWebsitePolicyScan>=5000){
      const subjects=(await allRecords(repositories.moderationHolds)).filter(h=>h.state==='active').map(h=>h.subjectId);
      if(subjects.length)for(const creator of await allRecords(repositories.creators))if(creator.homeCellId===cellId){const suspend=()=>publishing.suspendDependencies({workspaceId:creator.id,actorId:websitePolicyActor},subjects);await (websiteStore.withWebsitePolicy?websiteStore.withWebsitePolicy(creator.id,subjects,suspend):suspend());}
      lastWebsitePolicyScan=Date.now();
    }

    if(publishing){
      await (websiteStore?.withWebsiteMaintenance?websiteStore.withWebsiteMaintenance(()=>publishing.recoverOutbox()):publishing.recoverOutbox());
      const lease=await adapters.jobs.lease<{workspaceId:string;attemptId:string}>({cellId,types:['website.deploy'],leaseDurationSeconds:120,workerId});
      if(lease){try{if(lease.job.cellId!==cellId)throw new Error('Foreign website deployment rejected.');const deploy=()=>publishing.execute(lease.job.payload.workspaceId,lease.job.payload.attemptId);const attempt=await (websiteStore?.withWebsiteJob?websiteStore.withWebsiteJob(lease,deploy):deploy());
        if(['busy','unknown','verifying'].includes(attempt.state))await adapters.jobs.retry({id:lease.job.id,leaseToken:lease.leaseToken,retryAt:new Date(Date.now()+30000).toISOString(),error:{code:'website_reconciliation_pending',message:'Waiting for serving evidence or the prior writer.'}});
        else await adapters.jobs.complete({id:lease.job.id,leaseToken:lease.leaseToken});return {attempt};
      }catch(error){await adapters.jobs.retry({id:lease.job.id,leaseToken:lease.leaseToken,retryAt:new Date(Date.now()+30000).toISOString(),error:{code:'website_deployment_pending',message:'Hosting deployment requires recovery.'}});throw error;}}
    }

    if (websites) {
      const websiteLease = await adapters.jobs.lease<{ workspaceId: string; buildId: string }>({ cellId, types: ['website.build'], leaseDurationSeconds: 120, workerId });
      if (websiteLease) {
        try {
          if (websiteLease.job.cellId !== cellId) throw new Error('Foreign website job rejected.');
          const execute=()=>websites.execute(websiteLease.job.payload.workspaceId,websiteLease.job.payload.buildId);const build=await (websiteStore?.withWebsiteJob?websiteStore.withWebsiteJob(websiteLease,execute):execute());
          await adapters.jobs.complete({ id: websiteLease.job.id, leaseToken: websiteLease.leaseToken });
          return { build };
        } catch (error) {
          await adapters.jobs.retry({ id: websiteLease.job.id, leaseToken: websiteLease.leaseToken, retryAt: new Date(Date.now() + 1000).toISOString(), error: { code: 'website_worker_failed', message: 'Website worker could not complete this attempt.' } });
          throw error;
        }
      }
    }

    const lease = await adapters.jobs.lease<{ assetId: string }>({ cellId, types: ["asset.process"], leaseDurationSeconds: processingLeaseSeconds, workerId });
    if (!lease) return commerce?.runNextJob(workerId);
    let reservedUsageKey: string | undefined;
    try {
      if (lease.job.cellId !== cellId) throw new Error(`Foreign-cell job ${lease.job.cellId} rejected by ${cellId}`);
      const asset = await repositories.assets.get(lease.job.payload.assetId);
      if (!asset) throw new Error("Processing asset was not found.");
      requireHomeCell({ cellId }, asset);
      if (asset.instanceId !== (configuration.instanceId ?? 'local-reference')) throw new Error('Foreign-instance asset rejected.');
      const usageKey = processingUsageKey(asset);
      const reservationInput = { creatorId: asset.creatorId, operation: 'asset.process', processingCreditsDelta: 1, idempotencyKey: usageKey };
      if (usageOutbox) await usageOutbox.trackReservation(reservationInput, asset, lease.job);
      const reservation = await hostPorts.usageQuota.checkAndReserveQuota(reservationInput);
      if (!reservation.allowed) throw new Error(reservation.reasonCode ?? 'Processing quota exceeded.');
      reservedUsageKey = usageKey;
      if (asset.status === "ready") {
        const input = { creatorId: asset.creatorId, operation: 'asset.process', processingCreditsUsed: 1, idempotencyKey: usageKey };
        if (usageOutbox) await deferUsage(await repositories.transaction(transaction => usageOutbox.enqueue(input, dataHomeOf(asset), transaction)));
        else await hostPorts.usageQuota.recordUsageSettlement(input);
        await adapters.jobs.complete({ id: lease.job.id, leaseToken: lease.leaseToken });
        return { job: await adapters.jobs.get(lease.job.id), asset };
      }
      if (asset.status === 'failed' || asset.status === 'deleted') throw new Error('This asset requires explicit processing recovery.');
      const storage = (asset as AssetRecord & { storage?: { bucket: string; key: string; versionId?: string } }).storage;
      if (!storage) throw new Error("Processing asset has no source object.");
      const processing = await repositories.assets.update(asset.id, asset.revision, { status: "processing" });
      const source = await adapters.storage.get(storage);
      if (source.object.checksum !== processing.checksum || source.object.byteLength <= 0 || source.body.byteLength !== source.object.byteLength || createHash('sha256').update(source.body).digest('hex') !== processing.checksum) throw new Error("Processing source object failed checksum or metadata verification.");
      if (hostPorts.usageQuota.checkCurrentAdmission) {
        const currentQuota = await hostPorts.usageQuota.checkCurrentAdmission({ creatorId: asset.creatorId, operation: reservationInput.operation, idempotencyKey: usageKey });
        if (currentQuota?.allowed !== true) throw new Error(currentQuota?.reasonCode ?? 'Processing admission is no longer available.');
      }
      const assertCurrent = async () => {
        const current=await repositories.assets.get(processing.id), job=await adapters.jobs.get(lease.job.id);
        if(!current || current.revision!==processing.revision || current.status!=='processing' || current.creatorId!==processing.creatorId
          || current.instanceId!==processing.instanceId || current.homeCellId!==cellId || current.objectVersion!==processing.objectVersion
          || current.checksum!==processing.checksum || !job || job.state!=='leased' || job.attempt!==lease.job.attempt
          || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt)<=Date.now())throw new Error('Processing asset or lease is no longer current.');
      };
      const transform = async(bytes:Uint8Array,mimeType:string) => mimeType.startsWith('image/')
        ? hostPorts.watermarkAndTransform.applyDerivativeTransform({sourceBytes:bytes,mimeType,creatorId:processing.creatorId})
        : {bytes,mimeType};
      const outputs=await persistProcessedOutputs({repositories,storage:adapters.storage,owned:ownedObjectWrites,asset:processing,source:source.object,usageKey,assertCurrent,transform,
        produce:async()=>({result:await processor.process({assetId:processing.id,contentType:processing.mimeType,source:Uint8Array.from(source.body),sourceVersionId:processing.objectVersion}),
          fallback:()=>transform(Uint8Array.from(source.body),processing.mimeType)})});
      const processingResult=outputs.result, rendition=outputs.storage;
      const completed = await repositories.transaction(async (transaction) => {
        const ready = await repositories.assets.update(processing.id, processing.revision, { status: "ready", storage: rendition, originalStorage: storage, deliveryMimeType: rendition.contentType, processedRenditions: outputs.renditions } as Partial<AssetRecord>, { transaction });
        await repositories.moderationEvidence.create({ id: randomUUID(), instanceId: processing.instanceId, ...dataHomeOf(processing), subjectType: "asset", subjectId: processing.id, source: "local.processing", payload: { checksum: processing.checksum, sourceVersionId: processing.objectVersion, ...processingResult.metadata, renditions: processingResult.renditions, outputLineage: processingResult.renditions.map((rendition) => ({ outputId: rendition.id, sourceVersionId: rendition.sourceVersionId, role: rendition.role })) } }, { transaction });
        await repositories.usageEvents.create({ id: randomUUID(), instanceId: processing.instanceId, ...dataHomeOf(processing), accountId: processing.creatorId, meter: "processing_units", quantity: 1, idempotencyKey: `asset-processing:${processing.id}:${processing.objectVersion}` }, { transaction, idempotencyKey: `asset-processing:${processing.id}:${processing.objectVersion}` });
        await repositories.auditEvents.create({ id: randomUUID(), instanceId: processing.instanceId, ...dataHomeOf(processing), action: "asset.processing_completed", subjectId: processing.id, payload: { jobId: lease.job.id, sourceVersionId: processing.objectVersion } }, { transaction });
        const intent = usageOutbox ? await usageOutbox.enqueue({ creatorId: asset.creatorId, operation: 'asset.process', processingCreditsUsed: 1, idempotencyKey: usageKey }, dataHomeOf(asset), transaction) : undefined;
        return { ready, intent };
      });
      const processed = completed.ready;
      if (completed.intent) await deferUsage(completed.intent);
      else await hostPorts.usageQuota.recordUsageSettlement({ creatorId: asset.creatorId, operation: 'asset.process', processingCreditsUsed: 1, idempotencyKey: usageKey });
      // Prepare reusable, metadata-clean website bytes before Preview is requested.
      // A failed optional prewarm is retried by the normal snapshot resolver.
      if(websiteStore&&processed.mimeType.startsWith('image/'))try{await websiteRendition(processed);}catch{await audit({action:'website.rendition_deferred',subjectId:processed.id});}
      await adapters.jobs.complete({ id: lease.job.id, leaseToken: lease.leaseToken });
      return { job: await adapters.jobs.get(lease.job.id), asset: processed };
    } catch (error) {
      const details = { code: "processing_failed", message: error instanceof Error ? error.message : "Unknown processing failure" };
      await audit({ action: "asset.processing_failed", subjectId: lease.job.payload.assetId, payload: { jobId: lease.job.id, attempt: lease.job.attempt + 1, error: details } });
      if (lease.job.attempt >= lease.job.maxAttempts) {
        if (usageOutbox && lease.job.cellId === cellId) {
          const intent = await repositories.transaction(async transaction => {
            const asset = await repositories.assets.get(lease.job.payload.assetId, { transaction });
            if (!asset || asset.homeCellId !== cellId || asset.instanceId !== (configuration.instanceId ?? 'local-reference') || asset.status === 'ready') return;
            if (asset.status !== 'failed' && asset.status !== 'deleted') await repositories.assets.update(asset.id, asset.revision, { status: 'failed' }, { transaction });
            if (reservedUsageKey && reservedUsageKey === processingUsageKey(asset)) return usageOutbox.enqueue({ creatorId: asset.creatorId, operation: 'asset.process', processingCreditsUsed: 0, idempotencyKey: reservedUsageKey }, dataHomeOf(asset), transaction);
          });
          if (intent) await deferUsage(intent);
        }
        await adapters.jobs.deadLetter({ id: lease.job.id, leaseToken: lease.leaseToken, error: details });
      }
      else await adapters.jobs.retry({ id: lease.job.id, leaseToken: lease.leaseToken, error: details, retryAt: new Date(Date.now() + 1_000).toISOString() });
      throw error;
    }
  };

  let preparationTurn=true;
  const runNextJobOpen=async(workerId:string)=>{
    if(!preparationBindings)return runCoreJob(workerId);
    const first=preparationTurn;preparationTurn=!preparationTurn;
    const runPreparation=()=>preparationBindings.runNextJob(workerId),runCore=()=>runCoreJob(workerId);
    const polls=first?[runPreparation,runCore]:[runCore,runPreparation];
    let failed=false,failure:unknown;
    for(const poll of polls){
      try { const result=await poll();if(result!==undefined && result!==null)return result; }
      catch(error){
        failed=true;failure??=error;
        if(poll===runPreparation)try{await audit({action:'content.preparation.worker_deferred',subjectId:cellId});}catch{/* Preserve the original failure if durable diagnostics are also unavailable. */}
      }
    }
    if(failed)throw failure;
  };

  const handleOpen = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestId = request.headers["x-request-id"]?.toString() || randomUUID();
    try {
      const url = new URL(request.url ?? "/", configuration.publicBaseUrl);
      const method = request.method ?? "GET";
      if (commerce && await commerce.handle(request, response, url)) return;
      if (retainedSources && await retainedSources.handle(request,response)) return;
      if (contentPreparation && await contentPreparation.handle(request,response)) return;
      // Fail closed for the entire operations namespace, including future routes.
      // Product/deployment composition must explicitly define operator authority.
      if (url.pathname === '/v1/operations' || url.pathname.startsWith('/v1/operations/')) await operatorSession(request);
      if (method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, requestId }, requestId);
      if (method === "GET" && url.pathname === "/.well-known/ubeeq") { const publicUrl = new URL(configuration.publicBaseUrl); const enabled = publicUrl.protocol === "https:" && !!adapters.federation; return json(response, 200, { protocolVersion: "1", instanceId: configuration.instanceId ?? "local-reference", federationEnabled: enabled, ...(enabled ? { instanceUrl: publicUrl.toString(), actorDocumentUrl: new URL("/v1/federation/actors", publicUrl).toString(), publicationInboxUrl: new URL("/v1/federation/inbox", publicUrl).toString(), signingKeyId: adapters.federation!.keyId, signingPublicKey: adapters.federation!.publicKey, capabilities: ["publication-reference", "withdrawal"] } : {}), requestId }, requestId); }
      if ((method === "GET" && url.pathname === "/ready") || (method === "GET" && url.pathname === "/diagnostics")) {
        const dependencies = await Promise.all((composition.dependencies.diagnostics ?? []).map(async (dependency) => ({ name: dependency.name, ...(await dependency.check()) })));
        const ready = dependencies.every((dependency) => dependency.status === "ok");
        return json(response, ready ? 200 : 503, { ok: ready, status: ready ? "ok" : "degraded", cell: composition.configuration.cell, routingRevision: 1, dependencies, requestId }, requestId);
      }
      const isContributorMutation = (pathname: string, httpMethod: string) =>
        httpMethod !== "GET" && /^\/(?:v1|studio)\/creators\/[^/]+\/(members|invitations)/.test(pathname);

      const isOrganizationMutation = (pathname: string, httpMethod: string) =>
        httpMethod !== "GET" && /^\/(?:v1|studio)\/organizations(\/|$)/.test(pathname);

      if (isContributorMutation(url.pathname, method)) {
        if (!tenancy.isContributorManagementEnabled()) {
          throw new FeatureDisabledInSingleOperatorModeError("Contributor management");
        }
      }

      if (isOrganizationMutation(url.pathname, method)) {
        if (!tenancy.isOrganizationManagementEnabled()) {
          throw new FeatureDisabledInSingleOperatorModeError("Organization management");
        }
      }

      if (!url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/studio/")) throw new HttpError(404, "not_found", "Route was not found");

      if (url.pathname === '/v1/websites' || url.pathname.startsWith('/v1/websites/')) {
        response.setHeader('cache-control','private, no-store');
        if (!websites) throw new HttpError(404, 'websites_unavailable', 'Website publishing is not configured.');
        const identity = await session(request), creator = await creatorFor(identity.subject.id);
        requireHomeCell({ cellId }, creator);
        const websiteOperation=async()=>{
        if(url.pathname==='/v1/websites/hosting-connections'||url.pathname.startsWith('/v1/websites/hosting-connections/')){
          if(!hostingConnections||!websiteStore||!publishing)throw new HttpError(404,'hosting_unavailable','External hosting connections require installation configuration.');
          const result=await handleHostingConnectionRequest({actor:{actorId:identity.subject.id,workspaceId:creator.id},service:hostingConnections,store:websiteStore,publishing,adapters:hostingAdapters,parts:url.pathname.split('/').filter(Boolean).slice(2),method,body:()=>parseBody(request)});
          return json(response,method==='POST'?202:200,{...result,requestId},requestId);
        }
        if(method==='GET' && url.pathname==='/v1/websites/catalogue' && websiteStore) {
          const publications=[];
          const sources=await websiteSources(creator.id);
          for(const publication of sources.publications.values()) {
            if(publication.destination!=='local' || publication.status!=='live') continue;
            const work=sources.works.get(publication.workId);
            if(!work || work.creatorId!==creator.id) continue;
            try { const current=sources.current(work.id); publications.push({id:publication.id,title:work.title,assets:current.assets.filter(a=>a.mimeType.startsWith('image/')).map(a=>({id:a.id,label:work.title}))}); }
            catch(error) { if(error instanceof WebsiteError) continue; throw error; }
          }
          return json(response,200,{publications,requestId},requestId);
        }
        if(url.pathname.split('/')[4]==='hosting'){
          if(!publishing)throw new HttpError(404,'hosting_unavailable','Hosting is not configured.');
          const result=await handleWebsiteHostingRequest({service:publishing,actor:{actorId:identity.subject.id,workspaceId:creator.id},method,parts:url.pathname.split('/').filter(Boolean).slice(2),body:()=>parseBody(request),native:nativeHosting});
          return json(response,method==='POST'?202:200,{...result,requestId},requestId);
        }
        const result = await handleWebsiteRequest({ service: websites, actor: { actorId: identity.subject.id, workspaceId: creator.id }, request, response, url, body: () => parseBody(request) });
        if (!response.writableEnded) return json(response, method === 'POST'&&!url.pathname.endsWith('/preview-files') ? 202 : 200, { ...result as object, requestId }, requestId);
        return;
        };
        return await (websiteStore?.withWebsiteRequest?websiteStore.withWebsiteRequest(identity.subject,{actorId:identity.subject.id,workspaceId:creator.id},websiteOperation,()=>!request.aborted&&!response.destroyed&&!response.writableEnded):websiteOperation());
      }

      const routeMatch = url.pathname.match(/^\/v1\/routing\/creators\/([^/]+)$/);
      if (method === "GET" && routeMatch) {
        const route = await regionalControl().routingDirectory.get(routeMatch[1]);
        if (!route) throw new HttpError(404, "routing_not_found", "No home cell route exists for this creator");
        const requestedPath = url.searchParams.get("path");
        if (requestedPath) {
          const redirected = routeToHomeCell(route, requestedPath);
          response.statusCode = 307; response.setHeader("location", redirected.location); response.setHeader("x-request-id", requestId); response.end(); return;
        }
        return json(response, 200, { route: { creatorId: route.creatorId, homeCellId: route.homeCellId, homeRegion: route.homeRegion, endpoint: route.endpoint, routingRevision: route.routingRevision, state: route.state }, requestId }, requestId);
      }

      if (method === "POST" && url.pathname === "/v1/migrations") {
        const identity = await session(request); const creator = await creatorFor(identity.subject.id); requireHomeCell({ cellId }, creator);
        const body = await parseBody(request); const orchestrator = regionalControl().orchestrator; if (!orchestrator) throw new HttpError(503, "migration_worker_unavailable", "This cell has read-only routing access; migration execution is not configured"); const checkpoint = await orchestrator.request({ id: randomUUID(), creatorId: creator.id, destination: { cellId: requireString(body.destinationCellId, "destinationCellId"), region: requireString(body.destinationRegion, "destinationRegion"), endpoint: requireString(body.destinationEndpoint, "destinationEndpoint") } });
        await audit({ action: "regional_migration.requested", actorId: identity.subject.id, subjectId: creator.id, payload: { migrationId: checkpoint.id, destinationCellId: checkpoint.destination.cellId } });
        return json(response, 202, { migration: checkpoint, requestId }, requestId);
      }
      if (method === "GET" && url.pathname === "/v1/migrations/me") {
        const identity = await session(request); const creator = await creatorFor(identity.subject.id); const page = await regionalControl().migrationCheckpoints.list({ creatorId: creator.id, ...pageRequest(url) });
        return json(response, 200, { migrations: page.items, nextCursor: page.nextCursor, requestId }, requestId);
      }
      if (method === "GET" && url.pathname === "/v1/operations/regional/routes") {
        await operatorSession(request); const page = await regionalControl().routingDirectory.list(pageRequest(url));
        return json(response, 200, { routes: page.items, nextCursor: page.nextCursor, requestId }, requestId);
      }
      if (method === "GET" && url.pathname === "/v1/operations/regional/migrations") {
        await operatorSession(request); const page = await regionalControl().migrationCheckpoints.list({ creatorId: url.searchParams.get("creatorId") || undefined, ...pageRequest(url) });
        return json(response, 200, { migrations: page.items, nextCursor: page.nextCursor, requestId }, requestId);
      }
      const regionalOperationMatch = url.pathname.match(/^\/v1\/operations\/regional\/migrations\/([^/]+)\/(resume|rollback|retire)$/);
      if (method === "POST" && regionalOperationMatch) {
        const identity = await operatorSession(request); const [, migrationId, operation] = regionalOperationMatch;
        const control = regionalControl(); if (!control.orchestrator) throw new HttpError(503, "migration_worker_unavailable", "This cell has read-only routing access; migration execution is not configured"); const migration = operation === "resume" ? await control.orchestrator.resume(migrationId) : operation === "rollback" ? await control.orchestrator.rollback(migrationId) : await control.orchestrator.retire(migrationId);
        await audit({ action: `regional_migration.${operation}`, actorId: identity.subject.id, subjectId: migration.creatorId, payload: { migrationId } });
        return json(response, 200, { migration, requestId }, requestId);
      }

      if (method === "POST" && url.pathname === "/v1/federation/inbox") {
        const body = await parseBody(request); const envelope = body.envelope as Parameters<typeof verifyFederationEnvelope>[0];
        if (!envelope || !envelope.payload) throw new HttpError(400, "invalid_federation_reference", "A signed federation event is required");
        const event = validateRemotePublicationEvent(envelope.payload as Parameters<typeof validateRemotePublicationEvent>[0]);
        const decision = configuration.federationPolicy ? await configuration.federationPolicy.evaluateRemote({ actorId: event.actor.id, host: event.actor.host }) : "deny";
        if (decision !== "allow") throw new HttpError(403, "federation_not_accepted", "The instance policy did not accept this remote reference");
        if (!adapters.federation && !configuration.federationVerifier) throw new HttpError(503, "federation_unavailable", "Federation verification is not configured");
        await verifyFederationEnvelope(envelope, configuration.federationVerifier ?? adapters.federation!, adapters.federation!);
        const actorRecord = await repositories.federationActors.get(event.actor.id) ?? await repositories.federationActors.create({ id: event.actor.id, instanceId: configuration.instanceId ?? "local-reference", actorUri: event.actor.id, host: event.actor.host });
        const existing = await repositories.remotePublicationReferences.get(event.publication.id);
        if (existing && existing.actorId !== actorRecord.id) throw new HttpError(409, "federation_reference_conflict", "A remote publication identifier cannot change actors");
        if (event.type === "publication_withdrawn") {
          if (!existing) throw new HttpError(404, "federation_reference_not_found", "The remote publication reference was not accepted");
          const reference = await repositories.remotePublicationReferences.update(existing.id, existing.revision, { state: "withdrawn" });
          await audit({ action: "federation.reference_withdrawn", subjectId: reference.id, payload: { actorId: event.actor.id, publicationUrl: event.publication.canonicalUrl } });
          return json(response, 200, { reference, requestId }, requestId);
        }
        const reference = existing
          ? await repositories.remotePublicationReferences.update(existing.id, existing.revision, { publicationUri: event.publication.canonicalUrl, immutableId: event.publication.id, state: "accepted" })
          : await repositories.remotePublicationReferences.create({ id: event.publication.id, instanceId: configuration.instanceId ?? "local-reference", actorId: actorRecord.id, publicationUri: event.publication.canonicalUrl, immutableId: event.publication.id, state: "accepted" });
        await audit({ action: event.type === "publication_updated" ? "federation.reference_updated" : "federation.reference_accepted", subjectId: reference.id, payload: { actorId: event.actor.id, publicationUrl: event.publication.canonicalUrl } });
        return json(response, existing ? 200 : 201, { reference, requestId }, requestId);
      }

      if (method === 'GET' && url.pathname === '/v1/host-capabilities') {
        await session(request);
        return json(response, 200, { slots: hostPorts.studioUiSlots, transforms: { graphicWatermark: hostPorts.watermarkAndTransform.supportsGraphicWatermark, imageAdjustments: hostPorts.watermarkAndTransform.supportsImageAdjustments }, requestId }, requestId);
      }
      if (method === "POST" && url.pathname === "/v1/auth/sign-up") { if (!adapters.localIdentity) throw new HttpError(404, "local_auth_unavailable", "This instance uses an external identity provider"); const body = await parseBody(request); const email = requireString(body.email, "email");
        const admission = await configuration.registrationAdmission?.({ email, invitationCode: typeof body.invitationCode === 'string' ? body.invitationCode : undefined, organizationName: typeof body.organizationName === 'string' ? body.organizationName : undefined });
        if (admission && !admission.allowed) throw new HttpError(403, admission.reasonCode ?? 'registration_not_admitted', 'Registration requirements have not been satisfied.');
        const account = await adapters.localIdentity.register({ email, password: requireString(body.password, "password") }); return json(response, 201, { account, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/activity/command") {
        const identity = await session(request);
        if (!configuration.activityCommands) throw new HttpError(404, "activity_unavailable", "Activity interface is not configured");
        const body = await parseBody(request);
        const command = requireString(body.command, "command");
        if (command.length > 4096) throw new HttpError(400, "invalid_request", "Command exceeds 4096 characters");
        const text = await configuration.activityCommands.execute({ actorId: identity.subject.id, profileId: "web" }, command);
        response.setHeader("cache-control", "private, no-store");
        return json(response, 200, { text, requestId }, requestId);
      }
      if (method === 'POST' && url.pathname === '/v1/auth/sign-out') {
        const identity = await session(request);
        await adapters.identity.revokeSession({ sessionId: identity.id, reason: 'user.sign-out' });
        return json(response, 204, undefined, requestId);
      }
      if (method === "POST" && url.pathname === "/v1/auth/sign-in") {
        response.setHeader('cache-control', 'no-store');
        const authentication = adapters.passwordAuthentication ?? adapters.localIdentity;
        if (!authentication) throw new HttpError(404, "local_auth_unavailable", "This instance uses an external identity provider");
        const body = await parseBody(request);
        const credentials = { email: requireString(body.email, "email"), password: requireString(body.password, "password") };
        let result;
        try { result = await authentication.authenticate(credentials); }
        catch (error) {
          if (error instanceof PasswordAuthenticationError || !adapters.passwordAuthentication) throw error;
          throw new PasswordAuthenticationError('identity_provider_unavailable');
        }
        if (!result || typeof result.token !== 'string' || !result.token || result.token.trim() !== result.token || typeof result.session?.subject?.id !== 'string' || !result.session.subject.id || typeof result.session.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.session.expiresAt)) || Date.parse(result.session.expiresAt) <= Date.now()) throw new PasswordAuthenticationError('identity_provider_unavailable');
        return json(response, 200, { token: result.token, expiresAt: result.session.expiresAt, requestId }, requestId);
      }

      if (method === "POST" && url.pathname === "/v1/creators") {
        const identity = await session(request);
        const body = await parseBody(request);
        const existingUsers = tenancy.mode === 'single_operator' ? await getDistinctOperatorUserIds() : [];
        const handle = requireString(body.handle, 'handle'), displayName = requireString(body.displayName, 'displayName');
        const createCreator = () => createIntakeCreator(repositories, { instanceId: configuration.instanceId ?? 'local-reference', cellId, region, actorId: identity.subject.id,
          handle, displayName, idempotencyKey: body.idempotencyKey as string | undefined }, async (transaction, creatorId, preparedFactory) => {
        if (tenancy.mode === 'single_operator') {
          const claims = repositories.instanceOperators;
          if (!claims) throw new HttpError(503, 'operator_claim_store_required', 'An atomic operator claim store is required.');
          const id = configuration.instanceId ?? 'local-reference';
          const claim = await claims.get(id);
          const existing = existingUsers;
          if ((claim && claim.actorId !== identity.subject.id) || existing.some(actor => actor !== identity.subject.id)) throw new SingleOperatorLimitError();
          if (!claim) await claims.create({ id, instanceId: id, actorId: identity.subject.id }, { transaction });
        }
        await tenancy.assertCanCreateCreatorUser({
          existingCreatorUserCount: existingUsers.length,
          actorUserId: identity.subject.id
        });
        const created = await persistIntakeCreator(repositories, {
          id: creatorId,
          instanceId: configuration.instanceId ?? "local-reference",
          ...cellOwned,
          handle,
          displayName,
          subjectId: identity.subject.id
        }, identity.subject.id, transaction, preparedFactory??preparationBindings?.createCreator);
        await configuration.creatorLifecycle?.prepare({ creator: Object.freeze(structuredClone(created)), actorUserId: identity.subject.id, repositories, transaction });
        return created;
        },preparationBindings?.prepareCreatorCreation);
        let creator: CreatorRecord;
        try { creator = await createCreator(); }
        catch (error) {
          const claim = tenancy.mode === 'single_operator' ? await repositories.instanceOperators?.get(configuration.instanceId ?? 'local-reference') : undefined;
          if (claim && claim.actorId !== identity.subject.id) throw new SingleOperatorLimitError();
          throw error;
        }
        if (body.idempotencyKey !== undefined && !await tenancy.resolveCreatorRole(identity.subject.id, creator.id)) throw new HttpError(403, 'creator_not_accessible', 'Current access to this Creator is required.');
        let provisioning: { state: 'ready' | 'pending' } | undefined;
        if (configuration.creatorLifecycle) {
          provisioning = { state: 'pending' };
          try {
            const result = await configuration.creatorLifecycle.activate?.({ creator: Object.freeze(structuredClone(creator)), actorUserId: identity.subject.id });
            if (result?.state === 'ready') provisioning = { state: 'ready' };
          } catch { /* The committed host receipt remains pending for its worker. */ }
        }
        return json(response, provisioning?.state === 'pending' ? 202 : 201, { creator, ...(provisioning ? { provisioning } : {}), requestId }, requestId);
      }
      if (method === "GET" && url.pathname === "/v1/creators") {
        const identity = await session(request);
        const accessibleIds = await tenancy.listAccessibleCreatorIds(identity.subject.id);
        const creators = [];
        for (const id of accessibleIds) {
          const c = await repositories.creators.get(id);
          if (c) creators.push(c);
        }
        return json(response, 200, { creators, requestId }, requestId);
      }
      if (method === "GET" && url.pathname === "/v1/creators/me") {
        const identity = await session(request);
        const requestedId = resolveRequestCreatorId(request, url);
        return json(response, 200, { creator: await creatorFor(identity.subject.id, requestedId), requestId }, requestId);
      }
      if (method === 'GET' && (url.pathname === '/v1/works' || url.pathname === '/v1/collections')) {
        const identity = await session(request);
        const creator = await creatorFor(identity.subject.id, resolveRequestCreatorId(request, url));
        requireCompactContent(creator);
        if (url.pathname === '/v1/works') {
          const works = (await allRecords(repositories.works)).filter(work => work.creatorId === creator.id && work.status !== 'deleted');
          return json(response, 200, { works, requestId }, requestId);
        }
        const context=await collectionContext(identity.subject.id,creator);
        const collections=(await context.service.list({tenantId:creator.instanceId,creatorId:creator.id})).map(c=>({...collectionView(c,c.workIds),permissions:{canEdit:context.canEdit&&c.managementReady&&c.status!=='deleted'}}));
        return json(response, 200, { collections,capabilities:{canCreate:context.canEdit&&await context.store.isManagementReady(creator.id)}, requestId }, requestId);
      }
      const privateCollectionMatch=url.pathname.match(/^\/v1\/collections\/([^/]+)(\/works)?$/);
      if(privateCollectionMatch&&['GET','PATCH','DELETE','PUT'].includes(method)){
        const [,id,worksPath]=privateCollectionMatch;
        if(worksPath?method!=='PUT':!['GET','PATCH','DELETE'].includes(method))throw new HttpError(405,'method_not_allowed','Collection method is not supported.');
        const identity=await session(request),record=await repositories.collections.get(id);
        if(!record)throw new HttpError(404,'collection_not_found','Collection not found.');
        const creator=await creatorFor(identity.subject.id,resolveRequestCreatorId(request,url)??record.creatorId);
        if(record.creatorId!==creator.id||record.instanceId!==creator.instanceId)throw new HttpError(404,'collection_not_found','Collection not found.');
        requireHomeCell({cellId},record);
        if(record.dataHomeRegion!==creator.dataHomeRegion||record.routingRevision!==creator.routingRevision)throw new HttpError(409,'data_home_mismatch','Collection and Creator data homes do not match.');
        const context=await collectionContext(identity.subject.id,creator,method!=='GET');
        if(method==='GET')return json(response,200,{collection:await collectionResult(context,creator.id,id),requestId},requestId);
        const body=await parseBody(request),revision=collectionRevision(body);
        if(worksPath){
          collectionFields(body,['revision','workIds','expectedWorkIds']);
          if(!Array.isArray(body.workIds)||!Array.isArray(body.expectedWorkIds)||[...body.workIds,...body.expectedWorkIds].some(id=>typeof id!=='string'||!id.trim())||new Set(body.workIds).size!==body.workIds.length||new Set(body.expectedWorkIds).size!==body.expectedWorkIds.length)throw new HttpError(400,'invalid_request','Unique Work IDs and the previous order are required.');
          if(Buffer.byteLength(JSON.stringify(body))>300*1024)throw new HttpError(413,'collection_too_large','Collection order exceeds the safe aggregate size.');
          await context.service.replaceWorks(creator.instanceId,id,body.workIds as string[],body.expectedWorkIds as string[],revision);
        }else if(method==='DELETE'){
          collectionFields(body,['revision']);await context.service.remove(creator.instanceId,id,revision);
        }else{
          collectionFields(body,['revision','title','description','slug','type','visibility','coverAssetId','status']);
          const current=await context.service.get(creator.instanceId,id);
          const changes={...body};delete changes.revision;
          if(changes.coverAssetId!==undefined&&changes.coverAssetId!==null&&(typeof changes.coverAssetId!=='string'||!changes.coverAssetId))throw new HttpError(400,'invalid_request','Cover asset ID is invalid.');
          if(changes.title!==undefined)changes.title=requireString(changes.title,'title');
          if(changes.slug!==undefined){const slug=requireString(changes.slug,'slug');changes.slug=normalizeContentSlug(slug,{fallback:'collection',maxLength:160});}
          if(changes.coverAssetId===null)changes.coverAssetId=undefined;
          await context.service.update({...current,...changes} as RuntimeCollection,undefined,revision);
        }
        return json(response,200,{collection:await collectionResult(context,creator.id,id),requestId},requestId);
      }
      const privateWorkMatch = url.pathname.match(/^\/v1\/works\/([^/]+)$/);
      if (privateWorkMatch && ['GET', 'PATCH', 'DELETE'].includes(method)) {
        const identity = await session(request);
        const work = await ownedWork(privateWorkMatch[1], identity.subject.id, undefined, method === "GET" ? "read" : "edit");
        if (method === 'GET') {
          const assets = (await allRecords(repositories.assets)).filter(asset => asset.workId === work.id && asset.creatorId === work.creatorId);
          const publications = (await allRecords(repositories.publications)).filter(publication => publication.workId === work.id);
          return json(response, 200, { work, assets, publications, requestId }, requestId);
        }
        const role = await tenancy.resolveCreatorRole(identity.subject.id, work.creatorId);
        if (!role || !['owner', 'admin', 'editor'].includes(role)) throw new HttpError(403, 'work_edit_denied', 'Work editing access is required.');
        const body = await parseBody(request);
        if (body.revision !== work.revision) throw new HttpError(409, 'revision_conflict', 'Reload the work before saving changes.');
        const changes: Partial<WorkRecord> = method === 'DELETE' ? { status: 'deleted' } : { title: requireString(body.title ?? work.title, 'title') };
        const publicationSnapshot=method==='DELETE'?await requireSnapshot(repositories.publications):undefined;
        const updated = await repositories.transaction(async transaction=>{
          await authorizeWorkMutation(work.creatorId,identity.subject.id,work,transaction);
          if(publicationSnapshot){
            await publicationSnapshot.bind(transaction);
            if(publicationSnapshot.items.some(publication=>publication.workId===work.id&&publication.status==='live'))throw new HttpError(409,'work_is_published','Unpublish the Work before deleting it.');
          }
          return method==='DELETE'
          ? withCollectionWorkLifecycleFence(repositories,{instanceId:configuration.instanceId??'local-reference',cellId,region},work.creatorId,
              transaction=>repositories.works.update(work.id,work.revision,changes,{transaction}))
          : repositories.works.update(work.id, work.revision, changes,{transaction});
        });
        return json(response, 200, { work: updated, requestId }, requestId);
      }
      if (method === "POST" && url.pathname === "/v1/works") {
        const identity = await session(request);
        const requestedId = resolveRequestCreatorId(request, url);
        const creator = await creatorFor(identity.subject.id, requestedId);
        requireHomeCell({ cellId }, creator);
        await requireCreatorWritable(creator);
        const role = await tenancy.resolveCreatorRole(identity.subject.id, creator.id);
        if (!role || !['owner', 'admin', 'editor'].includes(role)) throw new HttpError(403, 'work_edit_denied', 'Work editing access is required.');
        const body = await parseBody(request);
        const work = await createIntakeWork(repositories,creator,identity.subject.id,requireString(body.title,'title'),body.idempotencyKey as string | undefined,
          transaction=>authorizeWorkMutation(creator.id,identity.subject.id,creator,transaction));
        return json(response, 201, { work, requestId }, requestId);
      }
      if (method === "POST" && url.pathname === "/v1/collections") {
        const identity = await session(request);
        const requestedId = resolveRequestCreatorId(request, url);
        const creator = await creatorFor(identity.subject.id, requestedId);
        const context=await collectionContext(identity.subject.id,creator,true);
        const body = await parseBody(request);
        collectionFields(body,['title','description','slug','type','visibility','coverAssetId','idempotencyKey']);
        const title=requireString(body.title,'title');
        if(body.type!==undefined&&!['collection','gallery','series','playlist'].includes(body.type as string)||body.visibility!==undefined&&!['private','unlisted','public'].includes(body.visibility as string)
          ||body.description!==undefined&&typeof body.description!=='string'||body.coverAssetId!==undefined&&body.coverAssetId!==null&&(typeof body.coverAssetId!=='string'||!body.coverAssetId))throw new HttpError(400,'invalid_request','Collection details are invalid.');
        const details={title,description:body.description??undefined,slug:normalizeContentSlug(body.slug===undefined?title:requireString(body.slug,'slug'),{fallback:'collection',maxLength:160}),
          type:(body.type??'collection') as RuntimeCollection['type'],visibility:(body.visibility??'private') as RuntimeCollection['visibility'],coverAssetId:(body.coverAssetId??undefined) as string|undefined};
        const collection=await createCollectionFromIntent(repositories,context.store,{instanceId:creator.instanceId,cellId,region,creatorId:creator.id,actorId:identity.subject.id,
          idempotencyKey:body.idempotencyKey as string|undefined,details},async id=>context.service.create({...details,id,collectionId:id,tenantId:creator.instanceId,creatorId:creator.id,
            status:'draft',slugHistory:[],revision:1,managementReady:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()} as RuntimeCollection));
        return json(response, 201, { collection:await collectionResult(context,creator.id,collection.id), requestId }, requestId);
      }

      if (method === 'POST' && url.pathname === '/v1/uploads') {
        const identity = await session(request), body = await parseBody(request);
        const work = await ownedWork(requireString(body.workId,'workId'),identity.subject.id); requireHomeCell({cellId},work);
        if (!uploadLifecycle) throw new HttpError(503,'durable_uploads_unavailable','Durable upload storage is not configured.');
        const byteLength = Number(body.byteLength);
        const checksum = typeof body.checksum === 'string' && /^[a-f0-9]{64}$/i.test(body.checksum) ? body.checksum.toLowerCase() : undefined;
        if (body.checksum !== undefined && !checksum) throw new HttpError(400,'invalid_request','checksum must be a SHA-256 digest.');
        const upload = await uploadLifecycle.initiate(work,identity.subject.id,{mimeType:requireString(body.mimeType,'mimeType'),byteLength,...(checksum ? {checksum} : {})},body.idempotencyKey as string | undefined);
        return json(response,201,{upload,requestId},requestId);
      }
      const contentMatch = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/content$/);
      if (method === 'PUT' && contentMatch) {
        const identity = await session(request), creator = await creatorFor(identity.subject.id,resolveRequestCreatorId(request,url));
        await requireCreatorWritable(creator);
        const role = await tenancy.resolveCreatorRole(identity.subject.id,creator.id);
        if (!role || !['owner','admin','editor'].includes(role)) throw new HttpError(403,'asset_edit_denied','Asset editing access is required.');
        if (!uploadLifecycle) throw new HttpError(503,'durable_uploads_unavailable','Durable upload storage is not configured.');
        const body = await parseBody(request);
        await uploadLifecycle.accept(contentMatch[1],creator.id,Buffer.from(requireString(body.base64,'base64'),'base64'));
        return json(response,204,undefined,requestId);
      }
      const completeMatch = url.pathname.match(/^\/v1\/uploads\/([^/]+)\/complete$/);
      if (method === 'POST' && completeMatch) {
        const identity = await session(request), body = await parseBody(request), work = await ownedWork(requireString(body.workId,'workId'),identity.subject.id);
        if (!uploadLifecycle) throw new HttpError(503,'durable_uploads_unavailable','Durable upload storage is not configured.');
        const result = await uploadLifecycle.complete(completeMatch[1],work,identity.subject.id,{checksum:requireString(body.checksum,'checksum').toLowerCase(),byteLength:Number(body.byteLength)},requestId);
        return json(response,202,{...result,requestId},requestId);
      }

      if (method === "POST" && url.pathname === "/v1/operations/jobs/run-next") { await session(request); const body = await parseBody(request); const result = await runNextJob(typeof body.workerId === "string" && body.workerId.trim() ? body.workerId.trim() : "local-reference-worker"); return json(response, 200, { result: result ?? null, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/jobs") { await session(request); const states = url.searchParams.getAll("state").filter((state): state is import("@ubeeq/jobs").JobState => ["queued", "leased", "completed", "retry_scheduled", "dead_lettered", "cancelled"].includes(state)); return json(response, 200, { jobs: await adapters.jobs.list({ cellId, states, limit: Number(url.searchParams.get("limit") ?? 50) }), requestId }, requestId); }
      const recoverJobMatch = url.pathname.match(/^\/v1\/operations\/jobs\/([^/]+)\/recover$/);
      if (method === "POST" && recoverJobMatch) { const identity = await session(request); const existingJob = await adapters.jobs.get(recoverJobMatch[1]); if (!existingJob) throw new HttpError(404, "job_not_found", "Job was not found"); if (existingJob.cellId !== cellId) throw new CellRoutingError(cellId, existingJob.cellId); requireRecoverableJob(existingJob.state);
        if (existingJob.type === 'asset.process') {
          const assetId = (existingJob.payload as { assetId?: string }).assetId;
          if (assetId) await repositories.transaction(async transaction => {
            const asset = await repositories.assets.get(assetId, { transaction });
            if (!asset || asset.instanceId !== (configuration.instanceId ?? 'local-reference')) throw new HttpError(404, 'asset_not_found', 'Processing asset was not found.');
            requireHomeCell({ cellId }, asset);
            if (asset.status === 'failed') await repositories.assets.update(asset.id, asset.revision, { status: 'pending', processingUsageKey: `asset-processing:${asset.id}:${asset.objectVersion}:recovery:${randomUUID()}` } as Partial<AssetRecord>, { transaction });
          });
        }
        const job = await adapters.jobs.recover({ id: existingJob.id }); await audit({ action: "job.recovered", actorId: identity.subject.id, subjectId: job.id, payload: { type: job.type } }); return json(response, 200, { job, requestId }, requestId); }
      const cancelJobMatch = url.pathname.match(/^\/v1\/operations\/jobs\/([^/]+)\/cancel$/);
      if (method === "POST" && cancelJobMatch) { const identity = await session(request); const body = await parseBody(request); const job = await adapters.jobs.get(cancelJobMatch[1]); if (!job) throw new HttpError(404, "job_not_found", "Job was not found"); if (job.cellId !== cellId) throw new CellRoutingError(cellId, job.cellId); await adapters.jobs.cancel({ id: job.id, reason: typeof body.reason === "string" ? body.reason : undefined }); await audit({ action: "job.cancelled", actorId: identity.subject.id, subjectId: job.id }); return json(response, 204, undefined, requestId); }
      if (method === "POST" && url.pathname === "/v1/operations/holds") { const identity = await session(request); const body = await parseBody(request); const hold = await repositories.moderationHolds.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", ...cellOwned, subjectType: requireString(body.subjectType, "subjectType"), subjectId: requireString(body.subjectId, "subjectId"), state: "active", reason: typeof body.reason === "string" ? body.reason : undefined }); lastWebsitePolicyScan=0;await audit({ action: "moderation.hold_created", actorId: identity.subject.id, subjectId: hold.subjectId, payload: { holdId: hold.id, reason: hold.reason } }); return json(response, 201, { hold, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/holds") { await session(request); const page = await repositories.moderationHolds.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, holds: page.items, nextCursor: page.nextCursor, requestId }, requestId); }
      const releaseHoldMatch = url.pathname.match(/^\/v1\/operations\/holds\/([^/]+)\/release$/);
      if (method === "POST" && releaseHoldMatch) { const identity = await session(request); const hold = await repositories.moderationHolds.get(releaseHoldMatch[1]); if (!hold) throw new HttpError(404, "hold_not_found", "Moderation hold was not found"); requireHomeCell({ cellId }, hold); const released = await repositories.moderationHolds.update(hold.id, hold.revision, { state: "released" }); await audit({ action: "moderation.hold_released", actorId: identity.subject.id, subjectId: released.subjectId, payload: { holdId: released.id } }); return json(response, 200, { hold: released, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/operations/review-cases") { const identity = await session(request); const body = await parseBody(request); const reviewCase = await repositories.reviewCases.create({ id: randomUUID(), instanceId: configuration.instanceId ?? "local-reference", ...cellOwned, subjectId: requireString(body.subjectId, "subjectId"), state: "open" }); await audit({ action: "moderation.review_case_opened", actorId: identity.subject.id, subjectId: reviewCase.subjectId, payload: { reviewCaseId: reviewCase.id } }); return json(response, 201, { reviewCase, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/review-cases") { await session(request); const page = await repositories.reviewCases.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, reviewCases: page.items, nextCursor: page.nextCursor, requestId }, requestId); }
      const reviewCaseMatch = url.pathname.match(/^\/v1\/operations\/review-cases\/([^/]+)$/);
      if (method === "POST" && reviewCaseMatch) { const identity = await session(request); const existing = await repositories.reviewCases.get(reviewCaseMatch[1]); if (!existing) throw new HttpError(404, "review_case_not_found", "Review case was not found"); requireHomeCell({ cellId }, existing); const body = await parseBody(request); const state = requireString(body.state, "state"); if (!["open", "assigned", "decided", "closed"].includes(state)) throw new HttpError(400, "invalid_request", "Review case state is invalid"); const updated = await repositories.reviewCases.update(existing.id, existing.revision, { state: state as typeof existing.state, assigneeId: typeof body.assigneeId === "string" ? body.assigneeId : existing.assigneeId }); await audit({ action: "moderation.review_case_updated", actorId: identity.subject.id, subjectId: updated.subjectId, payload: { reviewCaseId: updated.id, state: updated.state } }); return json(response, 200, { reviewCase: updated, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/moderation-evidence") { await session(request); const page = await repositories.moderationEvidence.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, evidence: page.items, nextCursor: page.nextCursor, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/audit-events") { await session(request); const page = await repositories.auditEvents.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, events: page.items, nextCursor: page.nextCursor, requestId }, requestId); }
      if (method === "GET" && url.pathname === "/v1/operations/usage-events") { await session(request); const page = await repositories.usageEvents.list(pageRequest(url)); return json(response, 200, { cell: { cellId, region, routingRevision: 1 }, events: page.items, nextCursor: page.nextCursor, requestId }, requestId); }

      const publicationMatch = url.pathname.match(/^\/v1\/works\/([^/]+)\/publications$/);
      if (method === "POST" && publicationMatch) {
        const identity = await session(request);
        const body = await parseBody(request);
        const service = new PublicationService(repositories, ownedWork, async (work, assets) => {
          await requireClearAdmission('Publication', [work.id, work.creatorId, ...assets.map(asset => asset.id)]);
          const decision = await hostPorts.publicationAdmission.evaluatePublication({ workId: work.id, workRevision: work.revision, actorUserId: identity.subject.id, creatorId: work.creatorId,
            destination: requireString(body.destination, 'destination'), visibility: 'public', textSignals: { title: work.title },
            mediaSignals: { assets: assets.map(asset => ({ id: asset.id, revision: asset.revision, checksum: asset.checksum, sourceVersionId: asset.objectVersion })) } });
          if (!decision.allowed) throw new HttpError(403, decision.reasonCodes[0] ?? 'publication_denied', decision.userMessage ?? 'Publication requires admission.');
        }, { prepareCommit:preparePublicationCommit, authorizeCommit: authorizePublicationCommit });
        const result = await service.publish({ workId: publicationMatch[1], actorId: identity.subject.id, destination: requireString(body.destination, 'destination'), idempotencyKey: request.headers['idempotency-key'] });
        return json(response, result.idempotent ? 200 : 201, { ...result, requestId }, requestId);
      }
      const nativePublicationMatch = url.pathname.match(/^\/(?:v1|studio)\/works\/([^/]+)\/publications\/(native|[a-zA-Z0-9_-]+)$/);
      if (method === "PUT" && nativePublicationMatch) {
        const identity = await session(request);
        const workId = nativePublicationMatch[1];
        const requestedDestination = nativePublicationMatch[2];
        const body = await parseBody(request);
        const work = await ownedWork(workId, identity.subject.id);
        const shouldPublish = body.published !== false;
        const canonicalDestination = requestedDestination;

        if (!shouldPublish) {
          const snapshot=await requireSnapshot(repositories.publications);
          await repositories.transaction(async transaction=>{
            await authorizeWorkMutation(work.creatorId,identity.subject.id,work,transaction);
            await snapshot.bind(transaction);
            const live=snapshot.items.filter(publication=>publication.workId===work.id&&publication.destination===canonicalDestination&&publication.status==='live');
            for(const publication of live){
              if(publication.instanceId!==work.instanceId||publication.homeCellId!==work.homeCellId)throw new HttpError(409,'publication_reconciliation_required','Publication custody requires reconciliation.');
              if('preparationVersion' in publication||'executionPolicy' in publication)throw new HttpError(409,'publication_reconciliation_required','Use the provider-aware reviewed workflow for this Publication.');
            }
            // Remove every live local receipt for this destination atomically.
            // Other destinations and the Work's readiness remain independent.
            for(const publication of live)await repositories.publications.update(publication.id,publication.revision,{status:'removed'},{transaction});
            if(live.length)await repositories.auditEvents.create({id:randomUUID(),instanceId:work.instanceId,...dataHomeOf(work),
              action:'work.withdrawn',actorId:identity.subject.id,subjectId:work.id,payload:{destination:canonicalDestination,publicationIds:live.map(publication=>publication.id)}},{transaction});
          });
          return json(response, 200, { workId, status: 'withdrawn', requestId }, requestId);
        }

        const service = new PublicationService(repositories, ownedWork, async (w, assets) => {
          await requireClearAdmission('Publication', [w.id, w.creatorId, ...assets.map(asset => asset.id)]);
          const decision = await hostPorts.publicationAdmission.evaluatePublication({ workId: w.id, workRevision: w.revision, actorUserId: identity.subject.id, creatorId: w.creatorId,
            destination: canonicalDestination, visibility: 'public', textSignals: { title: w.title },
            mediaSignals: { assets: assets.map(asset => ({ id: asset.id, revision: asset.revision, checksum: asset.checksum, sourceVersionId: asset.objectVersion })) } });
          if (!decision.allowed) throw new HttpError(403, decision.reasonCodes[0] ?? 'publication_denied', decision.userMessage ?? 'Publication requires admission.');
        }, { prepareCommit:preparePublicationCommit, authorizeCommit: authorizePublicationCommit });
        const result = await service.publish({
          workId,
          actorId: identity.subject.id,
          destination: canonicalDestination,
          idempotencyKey: request.headers['idempotency-key']
        });
        return json(response, result.idempotent ? 200 : 201, { ...result, requestId }, requestId);
      }
      const publicMatch = url.pathname.match(/^\/v1\/public\/works\/([^/]+)$/);
      if (method === "GET" && publicMatch) {
        response.setHeader('cache-control', 'private, no-store');
        const { work, assets, publications } = await currentPublicWork(publicMatch[1]);
        const delivered = await Promise.all(assets.map(async asset => {
          const storage = (asset as AssetRecord & { storage: { key: string; versionId?: string } }).storage;
          return { ...asset, deliveryMimeType: (asset as AssetRecord & {deliveryMimeType?:string}).deliveryMimeType ?? asset.mimeType, delivery: await adapters.delivery.issue({ object: { bucket: (storage as {bucket?:string}).bucket ?? cellId, key: storage.key, versionId: storage.versionId, scope: 'public' }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) };
        }));
        return json(response, 200, { work, assets: delivered, publications, requestId }, requestId);
      }
      const deliveryMatch = url.pathname.match(/^\/v1\/delivery\/([^/]+)$/);
      if (method === "GET" && deliveryMatch) {
        response.setHeader('cache-control', 'private, no-store');
        const developmentStorage = adapters.storage as ObjectStorage & { verifyDeliveryToken(token: string): { bucket: string; key: string; versionId?: string; scope: string; disposition?: string } };
        if (typeof developmentStorage.verifyDeliveryToken !== 'function') throw new HttpError(404, 'delivery_not_found', 'This delivery URL is served by the configured delivery provider');
        let object;
        try { object = developmentStorage.verifyDeliveryToken(deliveryMatch[1]); } catch { throw new HttpError(403, 'delivery_denied', 'Delivery token is invalid or expired'); }
        if (object.scope !== 'public') throw new HttpError(403, 'delivery_denied', 'This development delivery URL is not public');
        const matchesObject = (asset: AssetRecord) => {
          const storage = (asset as AssetRecord & { storage?: { bucket: string; key: string; versionId?: string } }).storage;
          return Boolean(object.versionId && storage?.bucket === object.bucket && storage.key === object.key && storage.versionId === object.versionId);
        };
        let matched: AssetRecord | undefined;
        for await (const asset of repositoryItems(request => repositories.assets.list(request))) {
          if (matchesObject(asset)) { matched = asset; break; }
        }
        if (!matched?.workId) throw new HttpError(404, 'delivery_not_found', 'Current published asset was not found');
        const current = await currentPublicWork(matched.workId);
        if (!current.assets.some(asset => asset.id === matched.id && matchesObject(asset))) throw new HttpError(404, 'delivery_not_found', 'Current published asset was not found');
        const found = await adapters.storage.get(object);
        response.statusCode = 200;
        response.setHeader('content-type', found.object.contentType);
        if (object.disposition) response.setHeader('content-disposition', object.disposition);
        response.setHeader('x-request-id', requestId); response.end(found.body); return;
      }
      if (method === "GET" && url.pathname === "/v1/exports/me") {
        const identity = await session(request); const creator = await creatorFor(identity.subject.id); requireCompactContent(creator); requireHomeCell({ cellId }, creator); await requireCreatorWritable(creator);
        const works = (await allRecords(repositories.works)).filter((record) => record.creatorId === creator.id); const workIds = new Set(works.map(({ id }) => id));
        const assets = (await allRecords(repositories.assets)).filter((record) => record.creatorId === creator.id); const collections = (await allRecords(repositories.collections)).filter((record) => record.creatorId === creator.id);
        const publications = (await allRecords(repositories.publications)).filter((record) => workIds.has(record.workId)); const publicationIntents = (await allRecords(repositories.publicationIntents)).filter((record) => workIds.has(record.workId));
        const subjectIds = new Set([creator.id, ...works.map(({ id }) => id), ...assets.map(({ id }) => id)]); const moderationEvidence = (await allRecords(repositories.moderationEvidence)).filter((record) => subjectIds.has(record.subjectId)); const moderationHolds = (await allRecords(repositories.moderationHolds)).filter((record) => subjectIds.has(record.subjectId)); const reviewCases = (await allRecords(repositories.reviewCases)).filter((record) => subjectIds.has(record.subjectId)); const auditEvents = (await allRecords(repositories.auditEvents)).filter((record) => Boolean(record.subjectId && subjectIds.has(record.subjectId))); const usageEvents = (await allRecords(repositories.usageEvents)).filter((record) => record.accountId === creator.id);
        const integrationAccounts = (await allRecords(repositories.integrationAccounts)).filter((record) => record.creatorId === creator.id).map(({ credentialReference: _credentialReference, ...record }) => ({ ...record, credentialExcluded: true as const })); const exportCheckpoints = (await allRecords(repositories.exportManifests)).filter((record) => record.creatorId === creator.id); const importCheckpoints = (await allRecords(repositories.importCheckpoints)).filter((record) => record.creatorId === creator.id);
        const objectInventory = assets.map(creatorAssetObjectInventory); const processing = assets.map((asset) => ({ id: `asset-processing:${asset.id}`, assetId: asset.id, ...dataHomeOf(asset), state: asset.status }));
        const manifest = createCreatorExport({ exportedAt: new Date().toISOString(), creator, works, assets, collections, publications, publicationIntents, processing, moderationEvidence, moderationHolds, reviewCases, auditEvents, usageEvents, integrationAccounts, exportCheckpoints, importCheckpoints, objectInventory }); await repositories.exportManifests.create({ id: `export-${manifest.checksum}`, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, schemaVersion: manifest.schemaVersion, checksum: manifest.checksum, objectReference: `inline:${manifest.checksum}` }, { idempotencyKey: `export:${manifest.checksum}` }); await audit({ action: "creator.export_generated", actorId: identity.subject.id, subjectId: creator.id, payload: { checksum: manifest.checksum } }); return json(response, 200, { ...manifest, requestId }, requestId);
      }
      if (method === "POST" && url.pathname === "/v1/imports/validate") { await session(request); const body = await parseBody(request); let manifest; try { manifest = validateCreatorExport(body.manifest); } catch (error) { throw new HttpError(400, "invalid_export_manifest", error instanceof Error ? error.message : "Export manifest is invalid"); } const plan = planCreatorImport(manifest, { targetCreatorId: "validation", existingWorkIds: (await allRecords(repositories.works)).map(({ id }) => id), existingAssetIds: (await allRecords(repositories.assets)).map(({ id }) => id), existingCollectionIds: (await allRecords(repositories.collections)).map(({ id }) => id), existingIds: await existingImportIds() }); return json(response, 200, { plan, requestId }, requestId); }
      if (method === "POST" && url.pathname === "/v1/imports") {
        const identity = await session(request); const body = await parseBody(request); let manifest;
        try { manifest = validateCreatorExport(body.manifest); } catch (error) { throw new HttpError(400, "invalid_export_manifest", error instanceof Error ? error.message : "Export manifest is invalid"); }
        const creator = await creatorFor(identity.subject.id); requireCompactContent(creator); requireHomeCell({ cellId }, creator); await requireCreatorWritable(creator);
        if (body.importId !== undefined && (typeof body.importId !== 'string' || !body.importId.trim() || body.importId.length > 200)) throw new HttpError(400, 'invalid_import_id', 'Import ID must be a non-empty string of at most 200 characters.');
        const importId = typeof body.importId === 'string' ? body.importId.trim() : randomUUID();
        const requireMatchingCheckpoint = (checkpoint: ImportCheckpointRecord) => {
          if (checkpoint.creatorId !== creator.id || checkpoint.instanceId !== creator.instanceId || checkpoint.importId !== importId ||
            JSON.stringify(dataHomeOf(checkpoint)) !== JSON.stringify(dataHomeOf(creator))) throw new HttpError(409, 'import_id_conflict', 'Import ID is unavailable for this creator.');
          if (checkpoint.cursor !== manifest.checksum) throw new HttpError(409, 'import_manifest_conflict', 'Import ID is already bound to a different manifest.');
        };
        const existing = await repositories.importCheckpoints.get(importId);
        if (existing) requireMatchingCheckpoint(existing);
        if (existing?.state === "completed") return json(response, 200, { importId, checkpoint: existing, idempotent: true, requestId }, requestId);
        const allWorks = (await allRecords(repositories.works)), allAssets = (await allRecords(repositories.assets)), allCollections = (await allRecords(repositories.collections));
        const plan = planCreatorImport(manifest, { targetCreatorId: creator.id, existingWorkIds: allWorks.map(({ id }) => id), existingAssetIds: allAssets.map(({ id }) => id), existingCollectionIds: allCollections.map(({ id }) => id), existingIds: await existingImportIds() });
        if (body.dryRun !== false || !plan.valid) return json(response, 200, { dryRun: true, plan, requestId }, requestId);
        const checkpoint = existing ?? await repositories.importCheckpoints.create({ id: importId, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, importId, state: "planned", cursor: manifest.checksum }, { idempotencyKey: `import:${importId}` });
        requireMatchingCheckpoint(checkpoint);
        const running = await repositories.importCheckpoints.update(checkpoint.id, checkpoint.revision, { state: "running", cursor: manifest.checksum });
        try {
          const completed = await repositories.transaction(async (transaction) => {
            for (const work of manifest.works) await repositories.works.create({ ...work, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, status: work.status === "published" ? "ready" : work.status }, { transaction, idempotencyKey: `import:${importId}:work:${work.id}` });
            for (const asset of manifest.assets) { const { storage: _storage, originalStorage: _originalStorage, processedRenditions: _processedRenditions, deliveryMimeType: _deliveryMimeType, ...portableAsset } = asset as AssetRecord & { storage?: unknown; originalStorage?: unknown; processedRenditions?:unknown;deliveryMimeType?:unknown }; await repositories.assets.create({ ...portableAsset, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, status: "pending" }, { transaction, idempotencyKey: `import:${importId}:asset:${asset.id}` }); }
            for (const collection of manifest.collections) await repositories.collections.create({ ...collection, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id }, { transaction, idempotencyKey: `import:${importId}:collection:${collection.id}` });
            await invalidateCollectionDirectoryForImport(repositories,creator,manifest.collections.map(c=>c.id),transaction);
            const publicationRestoreMaps = { publications: Object.fromEntries(manifest.publications.map(p => [p.id, p.id])),
              works: Object.fromEntries(manifest.works.map(w => [w.id, w.id])), assets: Object.fromEntries(manifest.assets.map(a => [a.id, a.id])),
              collections: Object.fromEntries(manifest.collections.map(c => [c.id, c.id])) };
            for (const publication of manifest.publications) await repositories.publications.create({ ...restorePublicationImageRecord(publication, publicationRestoreMaps),
              instanceId: creator.instanceId, ...dataHomeOf(creator) }, { transaction, idempotencyKey: `import:${importId}:publication:${publication.id}` });
            for (const intent of manifest.publicationIntents) await repositories.publicationIntents.create({ ...intent, instanceId: creator.instanceId, ...dataHomeOf(creator),
              idempotencyKey: `restored:${importId}:${intent.id}` }, { transaction, idempotencyKey: `import:${importId}:intent:${intent.id}` });
            for (const evidence of manifest.moderationEvidence) await repositories.moderationEvidence.create({ ...evidence, instanceId: creator.instanceId, ...dataHomeOf(creator) }, { transaction, idempotencyKey: `import:${importId}:evidence:${evidence.id}` });
            for (const hold of manifest.moderationHolds) await repositories.moderationHolds.create({ ...hold, instanceId: creator.instanceId, ...dataHomeOf(creator) }, { transaction, idempotencyKey: `import:${importId}:hold:${hold.id}` });
            for (const reviewCase of manifest.reviewCases) await repositories.reviewCases.create({ ...reviewCase, instanceId: creator.instanceId, ...dataHomeOf(creator) }, { transaction, idempotencyKey: `import:${importId}:review:${reviewCase.id}` });
            for (const event of manifest.auditEvents) await repositories.auditEvents.create({ ...event, instanceId: creator.instanceId, ...dataHomeOf(creator), actorId: undefined }, { transaction, idempotencyKey: `import:${importId}:audit:${event.id}` });
            for (const event of manifest.usageEvents) await repositories.usageEvents.create({ ...event, instanceId: creator.instanceId, ...dataHomeOf(creator), accountId: creator.id }, { transaction, idempotencyKey: `import:${importId}:usage:${event.id}` });
            for (const account of manifest.integrationAccounts) { const { credentialExcluded: _credentialExcluded, ...portableAccount } = account; await repositories.integrationAccounts.create({ ...portableAccount, instanceId: creator.instanceId, ...dataHomeOf(creator), creatorId: creator.id, health: "blocked", credentialReference: undefined }, { transaction, idempotencyKey: `import:${importId}:integration:${account.id}` }); }
            const completed = await repositories.importCheckpoints.update(running.id, running.revision, { state: 'completed', cursor: manifest.checksum }, { transaction });
            await repositories.auditEvents.create({ id: randomUUID(), instanceId: creator.instanceId, ...dataHomeOf(creator), action: 'creator.import_completed', actorId: identity.subject.id,
              subjectId: creator.id, payload: { importId, checksum: manifest.checksum, plan: plan.itemCounts, originalFilesTransferred: false } }, { transaction });
            return completed;
          });
          return json(response, 201, { importId, checkpoint: completed, plan, originalFilesTransferred: false, requestId }, requestId);
        } catch (error) {
          const committed = await repositories.importCheckpoints.get(importId);
          if (committed?.state === 'completed') {
            requireMatchingCheckpoint(committed);
            return json(response, 200, { importId, checkpoint: committed, idempotent: true, originalFilesTransferred: false, requestId }, requestId);
          }
          await repositories.importCheckpoints.update(running.id, running.revision, { state: "failed", cursor: manifest.checksum }).catch(() => undefined); throw error;
        }
      }
      throw new HttpError(404, "not_found", "Route was not found");
    } catch (error) {
      if(error instanceof OptimisticConcurrencyError)return json(response,409,{error:{code:'revision_conflict',message:'This resource changed. Reload before saving.',requestId}},requestId);
      if(error instanceof CreatorCollectionError)return json(response,error.code==='access_denied'?403:error.code==='not_found'?404:['slug_conflict','revision_conflict'].includes(error.code)?409:400,{error:{code:error.code,message:error.message,requestId}},requestId);
      if(error instanceof CollectionManagementError)return json(response,error.code==='invalid_collection'?400:error.code==='collection_too_large'?413:409,{error:{code:error.code,message:error.message,requestId}},requestId);
      if (error instanceof TenancyAdmissionError) return json(response, 403, { error: { code: error.reasonCode, message: error.message, requestId } }, requestId);
      if (error instanceof SingleOperatorLimitError || (error as any)?.code === "SINGLE_OPERATOR_INSTANCE_LIMIT") {
        return json(response, 403, { error: { code: "SINGLE_OPERATOR_INSTANCE_LIMIT", message: (error as Error).message, requestId } }, requestId);
      }
      if (error instanceof FeatureDisabledInSingleOperatorModeError || (error as any)?.code === "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE") {
        return json(response, 403, { error: { code: "FEATURE_DISABLED_IN_SINGLE_OPERATOR_MODE", message: (error as Error).message, requestId } }, requestId);
      }
      if (error instanceof UploadLifecycleError || error instanceof WorkIntakeError || error instanceof CreatorIntakeError) return json(response,error.status,{error:{code:error.code,message:error.message,requestId}},requestId);
      if (error instanceof PasswordAuthenticationError) return json(response, error.code === 'invalid_credentials' ? 401 : error.code === 'authentication_challenge_required' ? 409 : 503, { error: { code: error.code, message: error.message, requestId } }, requestId);
      if (error instanceof WebsiteError) return json(response, error.code === 'preview_file_too_large' ? 413 : error.code === 'authorization_denied' ? 403 : error.code.endsWith('not_found') ? 404 : error.code.includes('conflict') ? 409 : 400, { error: { code: error.code, message: error.message, requestId } }, requestId);
      if (error instanceof JobRecoveryError) return json(response, 409, { error: { code: error.code, message: error.message, requestId } }, requestId);
      if (error instanceof PublicationRequestError) return json(response, ['invalid_request', 'invalid_idempotency_key'].includes(error.code) ? 400 : 409, { error: { code: error.code, message: error.message, requestId } }, requestId);
      if (error instanceof UniqueConstraintError && error.constraint.name === 'creator_current_handle') {
        return json(response, 409, { error: { code: 'handle_conflict', message: 'Creator handle is already in use.', requestId } }, requestId);
      }
      const status = error instanceof HttpError ? error.status : error instanceof AuthorizationDeniedError ? 403 : error instanceof AdmissionBlockedError ? 409 : error instanceof CellRoutingError || error instanceof CellOwnershipError ? 409 : 500;
      const code = error instanceof HttpError ? error.code : error instanceof AuthorizationDeniedError ? "authorization_denied" : error instanceof AdmissionBlockedError ? "admission_blocked" : error instanceof CellRoutingError || error instanceof CellOwnershipError ? "foreign_cell" : "internal_error";
      const message = error instanceof Error ? error.message : "Unexpected error";
      const details = error instanceof AdmissionBlockedError ? error.decision : undefined;
      json(response, status, { error: { code, message, requestId, ...(details ? { details } : {}) } }, requestId);
    }
  };
  const lifetime=new ReferenceRuntimeLifetime();
  const handle=async(request:IncomingMessage,response:ServerResponse):Promise<void>=>{
    if(!lifetime.accepting){if(!response.destroyed&&!response.writableEnded){response.statusCode=503;response.setHeader('Content-Type','application/json; charset=utf-8');response.setHeader('Cache-Control','no-store');response.end(JSON.stringify({error:{code:'runtime_closed',message:'The Core runtime is closing or closed.'}}));}return;}
    return lifetime.run(()=>handleOpen(request,response));
  };
  const runNextJob=(workerId:string)=>lifetime.run(()=>runNextJobOpen(workerId));
  const server = createServer((request, response) => { void handle(request, response).catch(error=>{if(!response.destroyed)response.destroy(error instanceof Error?error:undefined);}); });
  const resolveConnectorAppCredentials = (input: { actorUserId: string; creatorId: string; provider: string }) => lifetime.run(async()=>{
    const role = await tenancy.resolveCreatorRole(input.actorUserId, input.creatorId);
    if (!role || !['owner', 'admin'].includes(role)) throw new HttpError(403, 'connector_access_denied', 'Creator management access is required.');
    return hostPorts.connectorAppCredentials.resolveOAuthClient(input.provider, input.creatorId);
  });
  let disposal:Promise<void>|undefined;
  const dispose=()=>disposal??=(async()=>{
    let failed=false,failure:unknown;
    for(const close of [()=>contentPreparation?.close(),()=>localWebsiteStore?.close(),()=>commerce?.close(),()=>localAdapters?.database.close(),()=>configuration.adapterOwnership==='runtime'?adapters.close?.():undefined])try{await close();}catch(error){if(!failed){failed=true;failure=error;}}
    if(failed)throw failure;
  })();
  return { commerce, website, server, handle, runNextJob, resolveConnectorAppCredentials, runOperation:<Result>(operation:()=>Promise<Result>)=>lifetime.run(operation), close:()=>lifetime.close(async()=>{
    let failed=false,failure:unknown;
    if(server.listening)try{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}catch(error){failed=true;failure=error;}
    try{await dispose();}catch(error){if(!failed){failed=true;failure=error;}}if(failed)throw failure;
  }) };
  }catch(error){
    // The synchronous constructor retains its original error. Start only real
    // resource cleanup; no domain/provider action or guessed close callback.
    if(configuration.adapterOwnership==='runtime')try{void Promise.resolve(adapters.close?.()).catch(()=>{});}catch{}
    try{localAdapters?.database.close();}catch{}throw error;
  }
};
