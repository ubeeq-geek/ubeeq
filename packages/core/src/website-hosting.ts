import { WebsiteError } from './websites.js';
import type { WebsiteDependency } from './websites.js';

export type HostingFamily = 'native' | 'aws' | 'netlify' | 'cloudflare-pages' | 'sftp';
export interface HostingCapabilities {
  emergencySuspension?:boolean; provision: boolean; select: boolean;
  staging: 'private' | 'public' | 'none';
  activation: 'release_reference' | 'filesystem_pointer' | 'in_place';
  propagation: 'local' | 'provider' | 'operator';
  rollback: 'retained_artifact' | 'provider' | 'unsupported';
  domains: 'provider_assisted' | 'operator_managed';
  redirects: 'native' | 'portable'; headers: boolean;
  unpublish: 'confirmed' | 'operator_required';
  maxFiles: number; maxBytes: number; maxFileBytes: number;
}
export interface HostingConnection {
  id: string; workspaceId: string; revision: number; family: HostingFamily;
  accountId: string; authorization: 'administrator' | 'oauth' | 'api_token' | 'ssh_key';
  credentialReference?: string; permissions: readonly string[];
  state: 'connected' | 'reconnect_required' | 'disconnected';
}
export interface WebsiteHostingTarget {
  id: string; workspaceId: string; websiteId: string; revision: number;
  label: string; adapterId: string; family: HostingFamily;
  connectionId?: string; accountId: string; remoteId: string;
  publicUrl: string; basePath: string; ownershipMarker: string;
  config: Readonly<Record<string,string>>; capabilities: HostingCapabilities;
  desiredGeneration: number; activeGeneration: number;
  activeAttemptId?: string; activeReleaseId?: string; activeArtifactDigest?: string;
  servingRemovalRequired?:boolean; serving: 'unpublished' | 'active' | 'suspended';
  lock?: { attemptId: string; executionId: string };
}
export type HostingAttemptState = 'queued' | 'generating' | 'uploading' | 'activating' | 'verifying' | 'published' | 'unpublished' | 'failed' | 'reconnect_required' | 'unknown' | 'superseded' | 'cancelled';
export interface HostingCheckpoint {
  releaseId?: string; data?: Readonly<Record<string,string>>;
}
export interface HostingVerification {
  observedAt: string; associationConfirmed: boolean; publicConfirmed: boolean;
  locations: readonly string[]; reasons: readonly string[];
}
export interface HostingOutcome {
  state: 'activated' | 'disabled' | 'pending' | 'unknown' | 'failed';
  releaseId?: string; publicUrl?: string; reason?: string;
}
export interface HostingArtifact {
  digest: string; sourceArtifactDigest: string; marker: string;
  files: ReadonlyMap<string,Uint8Array>; zip: Uint8Array;
}
export interface HostingDeploymentContext {
  target: WebsiteHostingTarget; connection?: HostingConnection;
  attemptId: string; generation: number; operation: 'publish' | 'rollback' | 'unpublish';
  artifact?: HostingArtifact; checkpoint: HostingCheckpoint;
  /** Durable checkpoint before subsequent remote side effects. Contains no secret values. */
  saveCheckpoint(checkpoint: HostingCheckpoint): Promise<void>;
  /** Must be awaited immediately before a serving-changing operation, including combined deploy APIs. */
  beforeActivation(): Promise<void>;
}
/** Explicit v2 extension. The original StaticDeploymentAdapter v1 remains unchanged. */
export interface WebsiteHostingAdapter {
  apiVersion: '2'; id: string; family: HostingFamily; capabilities: HostingCapabilities;
  validateTarget(target: WebsiteHostingTarget, connection?: HostingConnection): Promise<void>;
  transformFiles?(files:ReadonlyMap<string,Uint8Array>):ReadonlyMap<string,Uint8Array>;
  prepare(context: HostingDeploymentContext): Promise<HostingCheckpoint>;
  activate(context: HostingDeploymentContext): Promise<HostingOutcome>;
  reconcile(context: HostingDeploymentContext): Promise<HostingOutcome>;
  verify(context: HostingDeploymentContext, outcome: HostingOutcome): Promise<HostingVerification>;
  suspend?(target:WebsiteHostingTarget):Promise<void>;
  resume?(target:WebsiteHostingTarget,beforeServing:()=>Promise<void>):Promise<void>;
  domain?(input:{target:WebsiteHostingTarget;connection?:HostingConnection;domain:HostingDomain;operation:'request'|'verify'|'remove'}):Promise<Pick<HostingDomain,'state'|'instructions'|'providerId'>>;
  unpublish?(context: HostingDeploymentContext): Promise<HostingOutcome>;
}
export interface HostingDomain {
  id: string; workspaceId: string; targetId: string; revision: number; hostname: string;
  mode: 'primary' | 'alias'; state: 'requested' | 'verification_pending' | 'dns_pending' | 'certificate_pending' | 'ready' | 'active' | 'error' | 'removing' | 'removed';
  providerId?: string; instructions: readonly string[];
}
export interface HostingReleaseDependencies { dependencies: readonly WebsiteDependency[]; creatorIdentityId: string; }

/** A reusable publishing destination selection; saving it never deploys content. */
export interface WebsiteDestinationBinding {id:string;workspaceId:string;websiteId:string;revision:number;label:string;targetIds:readonly string[];enabled:boolean;}

/** Only for an explicit rejection of the serving-changing request itself, before any side effect. */
export class HostingActivationRejected extends WebsiteError {
  constructor(code:string,readonly retryAfterSeconds?:number){super(code,'Provider rejected the serving change. Reconnect or wait for its cooldown before retrying.');this.name='HostingActivationRejected';}
}
