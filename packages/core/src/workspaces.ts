import { createHash } from 'node:crypto';

export const WORKSPACE_ROLES = ['owner', 'administrator', 'editor', 'publisher', 'viewer'] as const;
export type WorkspaceRole = typeof WORKSPACE_ROLES[number];
export type WorkspaceOperation = 'view' | 'edit' | 'publish' | 'manage_connections' | 'manage_members' | 'transfer_ownership' | 'export';
export interface Workspace { id: string; kind: 'personal' | 'organization'; name: string; ownerUserId: string; createdAt: string; }
export interface WorkspaceMembership { workspaceId: string; userId: string; role: WorkspaceRole; status: 'invited' | 'active' | 'suspended' | 'removed'; resourceIds?: readonly string[]; }
export interface CreatorIdentity { id: string; workspaceId: string; kind: 'person' | 'studio' | 'organization' | 'brand'; displayName: string; }
export interface WorkCredit { workId: string; creatorIdentityId: string; role: string; displayName: string; }
const permissions: Record<WorkspaceRole, readonly WorkspaceOperation[]> = {
  owner: ['view','edit','publish','manage_connections','manage_members','transfer_ownership','export'], administrator: ['view','edit','publish','manage_connections','manage_members','export'],
  editor: ['view','edit','export'], publisher: ['view','edit','publish','export'], viewer: ['view']
};
export const membershipAllows = (membership: WorkspaceMembership | undefined, operation: WorkspaceOperation, resourceId?: string): boolean =>
  Boolean(membership?.status === 'active' && permissions[membership.role].includes(operation) && (!membership.resourceIds || (resourceId !== undefined && membership.resourceIds.includes(resourceId))));
export interface ExternalTarget { provider: 'facebook' | 'linkedin'; kind: 'facebook_page' | 'linkedin_member' | 'linkedin_organization'; remoteId: string; displayName: string; }
export interface AuthorizationGrant { id: string; workspaceId: string; connectionId: string; provider: 'facebook' | 'linkedin'; applicationDeploymentId: string; authorizingUserId: string; externalPrincipalId: string; targetIds: readonly string[]; scopes: readonly string[]; credentialReference: string; status: 'active' | 'expired' | 'revoked' | 'handover_required'; expiresAt?: string; }
export interface ProfessionalPublicationItem { workId: string; renditionAssetId: string; position: number; altText?: string; }
export interface ProfessionalPublicationRevision { publicationId: string; revision: number; workspaceId: string; creatorIdentityId: string; target: ExternalTarget; caption: string; link?: string; items: readonly ProfessionalPublicationItem[]; }
export interface PublicationApproval { publicationId: string; revision: number; payloadHash: string; approverUserId: string; approvedAt: string; }
export const professionalPublicationHash = (p: ProfessionalPublicationRevision): string => createHash('sha256').update(JSON.stringify({ ...p, link: p.link || '', items: [...p.items].sort((a,b) => a.position-b.position) })).digest('hex');
export const approvalMatches = (p: ProfessionalPublicationRevision, a?: PublicationApproval): boolean => Boolean(a && a.publicationId === p.publicationId && a.revision === p.revision && a.payloadHash === professionalPublicationHash(p));
export function publicationExecutionBlocks(input: { membership?: WorkspaceMembership; publication: ProfessionalPublicationRevision; grant?: AuthorizationGrant; approval?: PublicationApproval; approvalRequired?: boolean; now?: Date }): string[] {
  const { publication: p, grant: g } = input, blocks: string[] = [];
  if (!p.items.length || p.items.some(item => !membershipAllows(input.membership, 'publish', item.workId)) || input.membership?.workspaceId !== p.workspaceId) blocks.push('membership');
  if (!g || g.workspaceId !== p.workspaceId || g.provider !== p.target.provider || g.status !== 'active') blocks.push('grant');
  else { if (!g.targetIds.includes(p.target.remoteId)) blocks.push('target'); if (g.expiresAt && Date.parse(g.expiresAt) <= (input.now ?? new Date()).getTime()) blocks.push('grant_expired'); }
  if (input.approvalRequired && !approvalMatches(p, input.approval)) blocks.push('approval');
  return blocks;
}
export const requireGrantHandover = (grant: AuthorizationGrant, userId: string): AuthorizationGrant => grant.authorizingUserId === userId && grant.status === 'active' ? { ...grant, status: 'handover_required' } : grant;
export const createPersonalWorkspace = (userId: string, name: string, id: string, createdAt = new Date().toISOString()) => ({ workspace: { id, kind: 'personal' as const, name, ownerUserId: userId, createdAt }, membership: { workspaceId: id, userId, role: 'owner' as const, status: 'active' as const } });
