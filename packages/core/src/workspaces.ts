
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
  Boolean(membership?.status === 'active' && typeof membership.userId === 'string' && membership.userId.trim() && typeof membership.workspaceId === 'string' && membership.workspaceId.trim() && Object.hasOwn(permissions, membership.role) && permissions[membership.role]?.includes(operation) && (membership.resourceIds === undefined || (Array.isArray(membership.resourceIds) && resourceId !== undefined && membership.resourceIds.includes(resourceId))));
export interface ExternalTarget { provider: 'facebook' | 'linkedin'; kind: 'facebook_page' | 'linkedin_member' | 'linkedin_organization'; remoteId: string; displayName: string; }
export interface AuthorizationGrant { id: string; workspaceId: string; connectionId: string; provider: 'facebook' | 'linkedin'; targetKind: ExternalTarget['kind']; applicationDeploymentId: string; authorizingUserId: string; externalPrincipalId: string; targetIds: readonly string[]; scopes: readonly string[]; credentialReference: string; status: 'active' | 'expired' | 'revoked' | 'handover_required'; expiresAt?: string; }
export interface ProfessionalPublicationItem { workId: string; renditionAssetId?: string; workRevision?: number; position: number; altText?: string; }
export interface ProfessionalPublicationRevision { publicationId: string; revision: number; workspaceId: string; creatorIdentityId: string; target: ExternalTarget; caption: string; link?: string; items: readonly ProfessionalPublicationItem[]; }
export interface PublicationApproval { publicationId: string; revision: number; payloadHash: string; approverUserId: string; approvedAt: string; }
/** Canonical executable payload. Presentation labels and property insertion order do not change approval. */
export const professionalPublicationPayload = (p: ProfessionalPublicationRevision): string => {
  if ([p.publicationId, p.workspaceId, p.creatorIdentityId, p.target.remoteId].some(value => typeof value !== 'string' || !value.trim() || value.length > 500)
    || typeof p.caption !== 'string' || p.caption.length > 63206 || (p.link !== undefined && (typeof p.link !== 'string' || p.link.length > 2048))
    || !Number.isSafeInteger(p.revision) || p.revision < 1 || !Array.isArray(p.items) || p.items.length > 100
    || p.items.some(item => !Number.isSafeInteger(item.position) || item.position < 0 || !item.workId || (item.workRevision !== undefined && (!Number.isSafeInteger(item.workRevision) || item.workRevision < 1)))
    || new Set(p.items.map(item => item.position)).size !== p.items.length) throw new Error('Invalid publication revision or item positions.');
  return JSON.stringify([p.publicationId, p.revision, p.workspaceId, p.creatorIdentityId,
    p.target.provider, p.target.kind, p.target.remoteId, p.caption, p.link ?? '',
    [...p.items].sort((a,b) => a.position-b.position).map(item => [item.workId, item.renditionAssetId ?? '', item.workRevision ?? null, item.position, item.altText ?? ''])]);
};
/** Web Crypto keeps the core barrel usable in browser builds as well as servers. */
export const professionalPublicationHash = async (p: ProfessionalPublicationRevision): Promise<string> =>
  Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(professionalPublicationPayload(p)))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
export const approvalMatches = async (p: ProfessionalPublicationRevision, a?: PublicationApproval): Promise<boolean> => {
  if (!a) return false;
  const payload = professionalPublicationPayload(p), hash = await professionalPublicationHash(p);
  return Boolean(a.approverUserId && Number.isFinite(Date.parse(a.approvedAt)) && a.publicationId === p.publicationId
    && a.revision === p.revision && a.payloadHash === hash && professionalPublicationPayload(p) === payload);
};
export async function publicationExecutionBlocks(input: { membership?: WorkspaceMembership; publication: ProfessionalPublicationRevision; grant?: AuthorizationGrant;
  approval?: PublicationApproval; approvalRequired?: boolean; now?: Date; applicationDeploymentId?: string }): Promise<string[]> {
  const p = input.publication, payload = professionalPublicationPayload(p);
  const approved = input.approvalRequired ? await approvalMatches(p, input.approval) : true;
  const g = input.grant, blocks: string[] = [];
  if (professionalPublicationPayload(input.publication) !== payload) blocks.push('publication_changed');
  if (!membershipAllows(input.membership, 'publish', p.items.length ? p.items[0].workId : undefined)
    || p.items.some(item => !membershipAllows(input.membership, 'publish', item.workId)) || input.membership?.workspaceId !== p.workspaceId) blocks.push('membership');
  const validTarget = p.target.provider === 'facebook' ? p.target.kind === 'facebook_page'
    : p.target.provider === 'linkedin' && ['linkedin_member', 'linkedin_organization'].includes(p.target.kind);
  if (!validTarget || !g || g.workspaceId !== p.workspaceId || g.provider !== p.target.provider || g.targetKind !== p.target.kind || g.status !== 'active'
    || !g.id || !g.connectionId || !g.authorizingUserId || !g.externalPrincipalId || !g.credentialReference || !g.applicationDeploymentId || (input.applicationDeploymentId !== undefined && g.applicationDeploymentId !== input.applicationDeploymentId)) blocks.push('grant');
  else {
    if (!g.targetIds.includes(p.target.remoteId) || (p.target.kind === 'linkedin_member' && g.externalPrincipalId !== p.target.remoteId)) blocks.push('target');
    const now = (input.now ?? new Date()).getTime();
    if (!Number.isFinite(now) || (g.expiresAt !== undefined && (!Number.isFinite(Date.parse(g.expiresAt)) || Date.parse(g.expiresAt) <= now))) blocks.push('grant_expired');
    const scope = p.target.kind === 'facebook_page' ? 'pages_manage_posts' : p.target.kind === 'linkedin_member' ? 'w_member_social' : 'w_organization_social';
    if (!g.scopes.includes(scope)) blocks.push('scope');
  }
  if (!approved) blocks.push('approval');
  return blocks;
}
export const requireGrantHandover = (grant: AuthorizationGrant, userId: string): AuthorizationGrant => grant.authorizingUserId === userId && ['active', 'expired'].includes(grant.status) ? { ...grant, status: 'handover_required' } : grant;
export const createPersonalWorkspace = (userId: string, name: string, id: string, createdAt = new Date().toISOString()) => ({ workspace: { id, kind: 'personal' as const, name, ownerUserId: userId, createdAt }, membership: { workspaceId: id, userId, role: 'owner' as const, status: 'active' as const } });
