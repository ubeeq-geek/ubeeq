import type { HostingCheckpoint, HostingConnection, HostingAttemptState, HostingDomain, HostingVerification, WebsiteHostingTarget, WebsiteDependency, WebsiteCapabilities, WebsiteDestinationBinding } from '@ubeeq/core';

/** Snapshots are private encoded objects; binary rendition bytes have a store-owned encoding. */
export interface WebsitePublishPlan {
  id: string; workspaceId: string; websiteId: string; actorId: string;
  fingerprint: string; snapshotReference: string; websiteRevision: number;
  dependencies: readonly WebsiteDependency[]; creatorIdentityId: string;
  targets: readonly {id:string;revision:number;connectionRevision?:number;accountId:string}[];
  binding?:{id:string;revision:number}; policyRevision:string; limits: WebsiteCapabilities; createdAt: string; expiresAt: string;
}
export interface WebsitePublishIntent {
  id: string; workspaceId: string; websiteId: string; actorId: string;
  operation: 'publish' | 'rollback' | 'unpublish'; planId?: string; snapshotReference?: string;
  idempotencyKey: string; approvalFingerprint: string; createdAt: string;
  attemptIds: readonly string[];
}
export interface WebsiteDeploymentAttempt {
  id: string; workspaceId: string; targetId: string; targetRevision: number;
  intentId: string; generation: number; revision: number;
  connectionRevision?: number; accountId: string;
  state: HostingAttemptState; checkpoint: HostingCheckpoint;
  artifactDigest?: string; sourceArtifactDigest?: string; marker?: string;
  dependencies: readonly WebsiteDependency[]; creatorIdentityId: string;
  binding?:{id:string;revision:number}; renderLimits?: WebsiteCapabilities; executionId?: string; activationStarted: boolean;
  retryAfter?:string; verification?: HostingVerification; errorCode?: string; updatedAt: string;
}
export interface WebsiteHostingStore {
  getBinding(workspaceId:string,id:string):Promise<WebsiteDestinationBinding|undefined>;
  saveBinding(binding:WebsiteDestinationBinding,expectedRevision:number):Promise<void>;
  listBindings(workspaceId:string,websiteId:string):Promise<readonly WebsiteDestinationBinding[]>;
  getConnection(workspaceId:string,id:string):Promise<HostingConnection|undefined>;
  saveConnection(connection:HostingConnection,expectedRevision:number):Promise<void>;
  listConnections(workspaceId:string):Promise<readonly HostingConnection[]>;
  getTarget(workspaceId:string,id:string):Promise<WebsiteHostingTarget|undefined>;
  setServingState(workspaceId:string,targetId:string,state:WebsiteHostingTarget['serving'],operatorRequired?:boolean):Promise<void>;
  saveTarget(target:WebsiteHostingTarget,expectedRevision:number):Promise<void>;
  listTargets(workspaceId:string,websiteId:string):Promise<readonly WebsiteHostingTarget[]>;
  putPlan(plan:WebsitePublishPlan,snapshot:unknown):Promise<void>;
  cleanupUnacceptedPlans(now:string,limit:number):Promise<number>;
  getPlan(workspaceId:string,id:string):Promise<WebsitePublishPlan|undefined>;
  getSnapshot(workspaceId:string,reference:string):Promise<unknown>;
  /** One transaction creates intent, attempts, desired generations and recoverable outbox entries. */
  acceptIntent(input:{intent:WebsitePublishIntent;plan?:WebsitePublishPlan;targets:readonly WebsiteHostingTarget[];attempts:readonly WebsiteDeploymentAttempt[]}):Promise<WebsitePublishIntent>;
  getIntent(workspaceId:string,id:string):Promise<WebsitePublishIntent|undefined>;
  getAttempt(workspaceId:string,id:string):Promise<WebsiteDeploymentAttempt|undefined>;
  listAttempts(workspaceId:string,websiteId:string):Promise<readonly WebsiteDeploymentAttempt[]>;
  pendingOutbox(limit:number):Promise<readonly {workspaceId:string;attemptId:string}[]>;
  acknowledgeOutbox(workspaceId:string,attemptId:string):Promise<void>;
  /** A new execution can fence a pre-activation worker, never an uncertain activation. */
  claim(workspaceId:string,targetId:string,attemptId:string,executionId:string):Promise<boolean>;
  updateAttempt(attempt:WebsiteDeploymentAttempt,expectedRevision:number,executionId:string):Promise<void>;
  assertOwner(workspaceId:string,targetId:string,attemptId:string,executionId:string):Promise<WebsiteHostingTarget>;
  /** Confirmed active state and release dependencies commit together with lock release. */
  finish(attempt:WebsiteDeploymentAttempt,expectedRevision:number,executionId:string,outcome?:{releaseId:string;disabled:boolean}):Promise<void>;
  saveDomain(domain:HostingDomain,expectedRevision:number):Promise<void>;
  listDomains(workspaceId:string,targetId:string):Promise<readonly HostingDomain[]>;
}
