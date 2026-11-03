import { CommerceError, type CommerceDiscord } from '@ubeeq/commerce';
import { readBoundedResponseText } from './bounded-response-text.js';
import { parseRetryAfterSeconds } from './provider-errors.js';

export interface DiscordCommerceConfiguration { clientId: string; clientSecret: string; botToken: string; redirectUri: string; botUserId: string; fetch?: typeof fetch; }
export class DiscordCommerceClient implements CommerceDiscord {
  constructor(private readonly config: DiscordCommerceConfiguration) {
    if (!/^\d{1,22}$/.test(config.clientId) || !/^\d{1,22}$/.test(config.botUserId) || !config.clientSecret || !config.botToken || new URL(config.redirectUri).protocol !== 'https:')
      throw new CommerceError('invalid_discord_configuration');
  }
  private id(value: string) { if (!/^\d{1,22}$/.test(value)) throw new CommerceError('invalid_discord_id'); return value; }
  authorizationUrl(state: string, creator: boolean) {
    return 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri,
      response_type: 'code', scope: creator ? 'identify guilds' : 'identify', state });
  }
  installUrl() { return 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: this.config.clientId, scope: 'bot', permissions: '268435456' }); }
  private async request(path: string, authorization: string, method = 'GET', body?: string, form = false, missing = false): Promise<any> {
    let response: Response;
    try { response = await (this.config.fetch ?? fetch)('https://discord.com/api/v10' + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { authorization, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, ...(body ? { body } : {}) }); }
    catch { throw new CommerceError('discord_unavailable', 503); }
    if (missing && response.status === 404) { await response.body?.cancel(); return undefined; }
    if (!response.ok) {
      const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'));
      await response.body?.cancel().catch(() => {});
      const error = new CommerceError(response.status === 429 ? 'discord_rate_limited' : response.status === 403 ? 'discord_permissions_required' : 'discord_unavailable', 503);
      Object.assign(error, { retryAfterSeconds: retryAfter }); throw error;
    }
    if (response.status === 204) return;
    try { return JSON.parse(await readBoundedResponseText(response, 2 * 1024 * 1024)); }
    catch { throw new CommerceError('discord_invalid_response', 503); }
  }
  async exchange(code: string) {
    if (!code || code.length > 2048) throw new CommerceError('invalid_discord_code');
    const tokens = await this.request('/oauth2/token', 'Basic ' + Buffer.from(this.config.clientId + ':' + this.config.clientSecret).toString('base64'), 'POST',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri }).toString(), true);
    if (!tokens?.access_token || tokens.token_type?.toLowerCase() !== 'bearer') throw new CommerceError('discord_invalid_response', 503);
    const user = await this.request('/users/@me', 'Bearer ' + tokens.access_token);
    return { userId: this.id(user.id), accessToken: tokens.access_token as string };
  }
  async validateGuild(accessToken: string, guildId: string, roleIds: string[]) {
    this.id(guildId);
    let after: string | undefined, allowed = false;
    // Discord's guild list is paginated; never infer management permission from a client-supplied guild name.
    for (let page = 0; page < 100; page++) {
      const guilds = await this.request('/users/@me/guilds?limit=200' + (after ? '&after=' + this.id(after) : ''), 'Bearer ' + accessToken);
      if (!Array.isArray(guilds)) throw new CommerceError('discord_invalid_response', 503);
      const guild = guilds.find(g => g.id === guildId);
      if (guild) { const permissions = BigInt(guild.permissions ?? '0'); allowed = guild.owner === true || (permissions & 32n) !== 0n || (permissions & 8n) !== 0n; break; }
      if (guilds.length < 200) break;
      after = guilds.at(-1)?.id;
    }
    if (!allowed) throw new CommerceError('discord_server_management_required', 403);
    await this.validateRoles(guildId, roleIds);
  }
  async guilds(accessToken: string):Promise<{id:string;name:string}[]> {
    const result:{id:string;name:string}[]=[];let after:string|undefined;
    for(let page=0;page<100;page++){
      const guilds=await this.request('/users/@me/guilds?limit=200'+(after?'&after='+this.id(after):''),'Bearer '+accessToken);
      if(!Array.isArray(guilds))throw new CommerceError('discord_invalid_response',503);
      for(const guild of guilds){const p=BigInt(guild.permissions??'0');if(guild.owner===true||(p&32n)||(p&8n))result.push({id:this.id(guild.id),name:String(guild.name)});}
      if(guilds.length<200)return result;after=guilds.at(-1)?.id;
    }
    throw new CommerceError('discord_guild_limit',409);
  }
  async roles(guildId:string):Promise<{id:string;name:string}[]> {
    return (await this.manageableRoles(guildId)).map(role=>({id:role.id,name:String(role.name)}));
  }
  async validateInvite(guildId:string,inviteUrl:string){
    const url=new URL(inviteUrl),code=url.pathname.split('/').filter(Boolean).at(-1);
    if(!code||!/^[A-Za-z0-9_-]+$/.test(code))throw new CommerceError('invalid_discord_invite');
    const invite=await this.request('/invites/'+encodeURIComponent(code),'Bot '+this.config.botToken);
    if(invite.guild?.id!==guildId)throw new CommerceError('discord_invite_server_mismatch');
  }
  async member(guildId: string, userId: string) {
    const member = await this.request('/guilds/' + this.id(guildId) + '/members/' + this.id(userId), 'Bot ' + this.config.botToken, 'GET', undefined, false, true);
    if (!member) return undefined;
    if (!Array.isArray(member.roles) || member.roles.some((r: unknown) => typeof r !== 'string')) throw new CommerceError('discord_invalid_response', 503);
    return { roles: member.roles as string[] };
  }
  async validateRoles(guildId: string, roleIds: string[]) {
    const roles=await this.manageableRoles(guildId);
    for(const id of roleIds)if(!roles.some(role=>role.id===this.id(id)))throw new CommerceError('discord_role_hierarchy_conflict',409);
  }
  private async manageableRoles(guildId:string):Promise<any[]> {
    const [roles,bot] = await Promise.all([this.request('/guilds/' + this.id(guildId) + '/roles', 'Bot ' + this.config.botToken),this.member(guildId,this.config.botUserId)]);
    if (!Array.isArray(roles) || !bot) throw new CommerceError('discord_bot_not_installed', 409);
    const botRoles = roles.filter(r => r.id === guildId || bot.roles.includes(r.id));
    const permissions = botRoles.reduce((n, r) => n | BigInt(r.permissions ?? '0'), 0n);
    if (!(permissions & 268435456n) && !(permissions & 8n)) throw new CommerceError('discord_manage_roles_required', 409);
    const highest = botRoles.sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0];
    return roles.filter(role=>role.id!==guildId&&!role.managed&&(role.position<highest.position||(role.position===highest.position&&BigInt(role.id)>BigInt(highest.id))));
  }
  async addRole(guildId: string, userId: string, roleId: string) { await this.request('/guilds/' + this.id(guildId) + '/members/' + this.id(userId) + '/roles/' + this.id(roleId), 'Bot ' + this.config.botToken, 'PUT'); }
  async removeRole(guildId: string, userId: string, roleId: string) { await this.request('/guilds/' + this.id(guildId) + '/members/' + this.id(userId) + '/roles/' + this.id(roleId), 'Bot ' + this.config.botToken, 'DELETE'); }
}
