'use strict';
const { randomBytes, createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const codes = new Set(['UB', 'ES', 'NF', 'BP']);
class BrowserExtensionError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new BrowserExtensionError(code, status); };
function features(config) {
  const applicationCode = codes.has(config.applicationCode) ? config.applicationCode : null;
  const browserExtensionAvailable = Boolean(applicationCode) && config.browserExtensionAvailable === true;
  return { applicationCode, browserExtensionAvailable,
    deviantArtExtensionRichDescriptionEnabled: browserExtensionAvailable && config.deviantArtExtensionRichDescriptionEnabled === true,
    deviantArtExtensionRichDescriptionReady: false };
}
function text(value, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_input', 400);
  return value.trim();
}
function source(value) {
  if (!value || value.provider !== 'deviantart') fail('adapter_unavailable', 422);
  const accountId = text(value.accountId, 50).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(accountId)) fail('invalid_source', 400);
  return { provider: 'deviantart', accountId, siteId: accountId, objectType: 'deviation', method: 'browser_public_reference' };
}
function item(value, scope) {
  const remoteId = text(value.remoteId, 30);
  if (!/^\d+$/.test(remoteId)) fail('invalid_remote_id', 400);
  let url;
  try { url = new URL(text(value.sourceUrl, 2048)); } catch { fail('invalid_source_url', 400); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.deviantart.com' || url.port || url.username || url.password
    || url.search || url.hash || !url.pathname.toLowerCase().startsWith(`/${scope.accountId}/art/`)
    || !url.pathname.endsWith(`-${remoteId}`)) fail('invalid_source_url', 400);
  const publishedAt = value.publishedAt === undefined ? undefined : text(value.publishedAt, 40);
  if (publishedAt && !Number.isFinite(Date.parse(publishedAt))) fail('invalid_date', 400);
  // Allowlist only. Page HTML, sessions, arbitrary fetch URLs and provider payloads never enter canonical records.
  return { remoteId, sourceUrl: url.href, title: text(value.title, 500), ...(publishedAt ? { publishedAt } : {}),
    media: 'external_reference', observedAt: new Date().toISOString() };
}
function remoteKey(scope, remoteId) {
  return JSON.stringify([scope.provider, scope.siteId, scope.objectType, remoteId]);
}
function filterItems(items, filter = {}) {
  const name = typeof filter.name === 'string' ? filter.name.toLowerCase().slice(0, 500) : '';
  const from = filter.from ? Date.parse(filter.from) : null, to = filter.to ? Date.parse(filter.to) : null;
  if (from !== null && !Number.isFinite(from) || to !== null && !Number.isFinite(to) || from !== null && to !== null && from > to) fail('invalid_filter', 400);
  return items.filter(row => row.title.toLowerCase().includes(name) &&
    (from === null || Boolean(row.publishedAt) && Date.parse(row.publishedAt) >= from) &&
    (to === null || Boolean(row.publishedAt) && Date.parse(row.publishedAt) <= to));
}
/** SQLite is a single-cell adapter. Hosted/distributed products must supply a shared atomic store. */
class SqliteBrowserStore {
  constructor(path) {
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS browser_extension_records (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  get(id) { const row = this.db.prepare('SELECT value FROM browser_extension_records WHERE id=?').get(id); return row ? JSON.parse(row.value) : undefined; }
  put(id, value) { this.db.prepare('INSERT INTO browser_extension_records VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close() { this.db.close(); }
}
/** Every product supplies live policy, current Creator authority and an atomic, idempotent canonical importer. */
class BrowserExtensionService {
  constructor({ store, deploymentId, policy, authorize, importItem, existing, budget, galleryAccounts, galleryAccount, galleryCandidates, verifyGallery, now = Date.now }) {
    const namespace = hash(text(deploymentId, 500));
    this.store = { get: key => store.get(`${namespace}:${key}`), put: (key, value) => store.put(`${namespace}:${key}`, value), transaction: fn => store.transaction(fn) }; this.policy = policy; this.authorize = authorize; this.importItem = importItem;
    this.galleryAccounts = galleryAccounts; this.galleryAccount = galleryAccount; this.galleryCandidates = galleryCandidates; this.verifyGallery = verifyGallery;
    this.existing = existing; this.budget = budget; this.now = now;
  }
  enabled() { const f = features(this.policy()); if (!f.browserExtensionAvailable) fail('extension_unavailable', 403); return f.applicationCode; }
  async grant(userId, creatorId) {
    const applicationCode = this.enabled(); text(userId); text(creatorId);
    if (!await this.authorize(userId, creatorId)) fail('creator_access_required', 403);
    const code = secret();
    this.store.put(`grant:${hash(code)}`, { userId, creatorId, applicationCode, expiresAt: this.now() + 300000 });
    return { code, expiresAt: this.now() + 300000, creatorId, applicationCode };
  }
  async exchange(code, profileId) {
    const applicationCode = this.enabled(); text(code, 100); text(profileId, 100);
    const key = `grant:${hash(code)}`, approval = this.store.get(key);
    if (!approval || approval.used || approval.expiresAt <= this.now() || approval.applicationCode !== applicationCode) fail('approval_expired', 401);
    if (!await this.authorize(approval.userId, approval.creatorId)) fail('creator_access_required', 403);
    return this.store.transaction(() => {
      const current = this.store.get(key);
      if (current.used || current.expiresAt <= this.now()) fail('approval_expired', 401);
      const token = secret(), pairingId = secret();
      const pairing = { pairingId, tokenHash: hash(token), userId: approval.userId, creatorId: approval.creatorId,
        applicationCode, profileId, expiresAt: this.now() + 30 * 86400000, revoked: false };
      this.store.put(key, { ...current, used: true }); this.store.put(`pair:${hash(token)}`, pairing);
      this.store.put(`pairing:${pairingId}`, { tokenHash: hash(token), userId: pairing.userId, creatorId: pairing.creatorId });
      return { token, pairingId, creatorId: pairing.creatorId, applicationCode, expiresAt: pairing.expiresAt };
    });
  }
  async pairing(token) {
    const applicationCode = this.enabled();
    if (typeof token !== 'string' || token.length > 100) fail('pairing_required', 401);
    const pairing = this.store.get(`pair:${hash(token)}`);
    if (!pairing || pairing.revoked || pairing.expiresAt <= this.now() || pairing.applicationCode !== applicationCode) fail('pairing_required', 401);
    if (!await this.authorize(pairing.userId, pairing.creatorId)) fail('creator_access_required', 403);
    return pairing;
  }
  async disconnect(token) {
    if (typeof token !== 'string' || token.length > 100) fail('pairing_required', 401);
    const key = `pair:${hash(token)}`;
    this.store.transaction(() => {
      const pairing = this.store.get(key); if (!pairing) fail('pairing_required', 401);
      this.store.put(key, { ...pairing, revoked: true });
    });
  }
  async revoke(userId, pairingId) {
    const reference = this.store.get(`pairing:${text(pairingId, 100)}`);
    if (!reference || reference.userId !== userId || !await this.authorize(userId, reference.creatorId)) fail('pairing_not_found', 404);
    this.store.transaction(() => { const key = `pair:${reference.tokenHash}`; this.store.put(key, { ...this.store.get(key), revoked: true }); });
  }
  async listGalleryAccounts(token) {
    const pairing = await this.pairing(token);
    if (!this.galleryAccounts) fail('gallery_setup_unavailable', 422);
    return { items: await this.galleryAccounts(pairing), nativeConfirmationRequired: true, automaticCreationReady: false };
  }
  async prepareGallery(token, input) {
    const pairing = await this.pairing(token);
    if (!this.galleryAccount) fail('gallery_setup_unavailable', 422);
    const externalAccountId = text(input.externalAccountId, 200), name = text(input.name, 50);
    if (/[\u0000-\u001f\u007f]/.test(name) || input.kind !== 'premium' || input.parentFolderId !== undefined || input.currency !== 'USD'
      || !Number.isSafeInteger(input.priceCents) || input.priceCents < 1 || input.priceCents > 100000000) fail('invalid_gallery_setup', 400);
    const account = await this.galleryAccount(pairing, externalAccountId);
    if (!account || !/^[a-z0-9][a-z0-9-]{0,49}$/i.test(account.username) || !account.remoteId) fail('account_unverified', 409);
    const setup = { id: secret(), pairingId: pairing.pairingId, externalAccountId, account: { username: account.username, remoteId: account.remoteId },
      creatorId: pairing.creatorId, name, kind: 'premium', priceCents: input.priceCents, currency: 'USD',
      state: 'awaiting_native_creation', expiresAt: this.now() + 3600000, automaticCreationReady: false };
    await this.pairing(token);
    this.store.put(`gallery:${setup.id}`, setup);
    return this.galleryView(setup);
  }
  galleryView(setup) {
    const { pairingId, ...view } = setup;
    return { ...view, galleryUrl: `https://www.deviantart.com/${encodeURIComponent(setup.account.username)}/gallery`,
      nativeConfirmationRequired: true, priceVerified: false };
  }
  async gallerySetup(token, id) {
    const pairing = await this.pairing(token), setup = this.store.get(`gallery:${text(id, 100)}`);
    if (!setup || setup.pairingId !== pairing.pairingId || setup.expiresAt <= this.now()) fail('gallery_setup_expired', 409);
    return this.galleryView(setup);
  }
  async listGalleryCandidates(token, id) {
    const pairing = await this.pairing(token), setup = await this.gallerySetup(token, id);
    if (!this.galleryCandidates) fail('gallery_setup_unavailable', 422);
    const items = await this.galleryCandidates(pairing, setup);
    await this.pairing(token);
    return { items, automaticCreationReady: false };
  }
  async confirmGallery(token, id, remoteId) {
    const pairing = await this.pairing(token), setup = await this.gallerySetup(token, id);
    if (!this.verifyGallery) fail('gallery_setup_unavailable', 422);
    remoteId = text(remoteId, 200);
    const result = await this.verifyGallery(pairing, setup, remoteId, async () => {
      await this.pairing(token); await this.gallerySetup(token, id);
    });
    if (result.remoteId !== remoteId || result.name !== setup.name) fail('premium_gallery_unverified', 409);
    await this.pairing(token);
    const current = this.store.get(`gallery:${id}`);
    current.state = 'access_verified'; current.gallery = { remoteId: result.remoteId, name: result.name, accessType: 'premium' };
    this.store.put(`gallery:${id}`, current);
    return this.galleryView(current);
  }
  async preview(token, input) {
    const pairing = await this.pairing(token), scope = source(input.source);
    if (!Array.isArray(input.items) || input.items.length > 50 || !input.items.length) fail('invalid_page', 400);
    // A bounded page is a preview, never evidence of a complete inventory or deletion.
    const items = [...new Map(input.items.map(value => { const row = item(value, scope); return [row.remoteId, row]; })).values()];
    const rows = await Promise.all(items.map(async row => ({ ...row, alreadyPresent: await this.existing(pairing, scope, row) })));
    const previewId = secret(); this.store.put(`preview:${previewId}`, { pairingId: pairing.pairingId, scope, items: rows, expiresAt: this.now() + 1800000 });
    return { previewId, source: scope, creatorId: pairing.creatorId, items: rows, total: null, partialScan: true,
      capabilities: { browserImport: true, apiSync: false, apiPublish: false, browserPublish: false } };
  }
  async start(token, input) {
    const pairing = await this.pairing(token), preview = this.store.get(`preview:${text(input.previewId, 100)}`);
    if (!preview || preview.pairingId !== pairing.pairingId || preview.expiresAt <= this.now()) fail('preview_expired');
    if (!Array.isArray(input.selected) || input.selected.length > 50 || !input.selected.length) fail('selection_required', 400);
    const visible = new Set(filterItems(preview.items, input.filter).map(row => row.remoteId));
    if (input.selected.some(id => !visible.has(id))) fail('selection_outside_filter', 400);
    const requestId = text(input.requestId, 100), id = hash(JSON.stringify([pairing.pairingId, requestId]));
    const signature = hash(JSON.stringify([input.previewId, [...new Set(input.selected)].sort(), input.filter || {}]));
    return this.store.transaction(() => {
      const previous = this.store.get(`job:${id}`);
      if (previous) { if (previous.signature !== signature) fail('request_conflict'); return this.view(previous); }
      const job = { id, signature, pairingId: pairing.pairingId, creatorId: pairing.creatorId, scope: preview.scope,
        profileId: pairing.profileId, state: 'importing', revision: 1, createdAt: this.now(),
        items: preview.items.filter(row => input.selected.includes(row.remoteId)).map(row => ({ ...row, state: 'pending' })) };
      this.store.put(`job:${id}`, job); return this.view(job);
    });
  }
  view(job) {
    const count = state => job.items.filter(row => row.state === state).length;
    return { id: job.id, creatorId: job.creatorId, source: job.scope, state: job.state, revision: job.revision,
      imported: count('imported'), alreadyPresent: count('already_present'), failed: count('failed'),
      remaining: count('pending'), total: job.items.length,
      items: job.items.map(({ remoteId, state, workId }) => ({ remoteId, state, ...(workId ? { workId } : {}) })) };
  }
  pause(token, id, state = 'waiting_for_browser') {
    const pairing = typeof token === 'string' && this.store.get(`pair:${hash(token)}`);
    if (!pairing) fail('pairing_required', 401);
    return this.store.transaction(() => {
      const key = `job:${text(id, 100)}`, job = this.store.get(key);
      if (!job || job.pairingId !== pairing.pairingId) fail('job_not_found', 404);
      if (['completed', 'cancelled'].includes(job.state)) return this.view(job);
      job.state = state === 'waiting_for_authorization' ? state : 'waiting_for_browser';
      job.revision++; delete job.lease; this.store.put(key, job); return this.view(job);
    });
  }
  async get(token, id) {
    const pairing = await this.pairing(token), job = this.store.get(`job:${text(id, 100)}`);
    if (!job || job.pairingId !== pairing.pairingId) fail('job_not_found', 404); return this.view(job);
  }
  async control(token, id, action) {
    const pairing = await this.pairing(token);
    return this.store.transaction(() => {
      const job = this.store.get(`job:${text(id, 100)}`);
      if (!job || job.pairingId !== pairing.pairingId) fail('job_not_found', 404);
      if (!['cancel', 'retry'].includes(action)) fail('invalid_action', 400);
      if (action === 'retry' && job.state === 'cancelled') fail('job_cancelled');
      job.state = action === 'cancel' ? 'cancelled' : 'importing'; job.revision++; delete job.lease;
      if (action === 'retry') job.items.forEach(row => { if (row.state === 'failed') row.state = 'pending'; });
      this.store.put(`job:${id}`, job); return this.view(job);
    });
  }
  async step(token, id, observedSource, profileId) {
    let pairing;
    try { pairing = await this.pairing(token); }
    catch (error) { try { this.pause(token, id, 'waiting_for_authorization'); } catch {} throw error; }
    const scope = source(observedSource), key = `job:${text(id, 100)}`;
    const claim = this.store.transaction(() => {
      const job = this.store.get(key);
      if (!job || job.pairingId !== pairing.pairingId) fail('job_not_found', 404);
      if (job.state === 'cancelled' || job.state === 'completed') return { finished: true, job };
      if (JSON.stringify(job.scope) !== JSON.stringify(scope) || pairing.profileId !== profileId) {
        job.state = 'waiting_for_authorization'; job.revision++; delete job.lease; this.store.put(key, job); return { blocked: true, job };
      }
      if (job.lease && job.lease.until > this.now()) fail('lease_busy');
      const row = job.items.find(value => value.state === 'pending');
      if (!row) { job.state = job.items.some(value => value.state === 'failed') ? 'partially_completed' : 'completed'; delete job.lease; this.store.put(key, job); return { finished: true, job }; }
      const lease = secret(); job.lease = { token: lease, until: this.now() + 30000 }; job.state = 'importing'; this.store.put(key, job);
      return { job, row, lease, revision: job.revision };
    });
    if (claim.blocked) fail('account_changed');
    if (claim.finished) return this.view(claim.job);
    let result;
    try {
      await this.pairing(token); // Current deployment policy and Creator access, immediately before canonical mutation.
      if (this.budget && !await this.budget(pairing, scope)) fail('rate_limited', 429);
      result = await this.importItem(pairing, scope, claim.row, remoteKey(scope, claim.row.remoteId), async () => {
        await this.pairing(token);
        const current = this.store.get(key);
        if (!current || current.revision !== claim.revision || current.lease?.token !== claim.lease || current.lease.until <= this.now() || current.state !== 'importing') fail('lease_expired');
      });
    } catch (error) {
      this.store.transaction(() => {
        const job = this.store.get(key);
        if (job.lease?.token !== claim.lease) return;
        delete job.lease;
        if (['extension_unavailable', 'pairing_required', 'creator_access_required', 'rate_limited', 'lease_expired'].includes(error.code)) {
          job.state = error.code === 'rate_limited' ? 'waiting_for_browser' : 'waiting_for_authorization';
        } else { job.items.find(value => value.remoteId === claim.row.remoteId).state = 'failed'; job.state = 'partially_completed'; }
        this.store.put(key, job);
      });
      throw error;
    }
    return this.store.transaction(() => {
      const job = this.store.get(key);
      if (job.lease?.token !== claim.lease || job.revision !== claim.revision || job.lease.until <= this.now()) fail('lease_expired');
      const row = job.items.find(value => value.remoteId === claim.row.remoteId);
      row.state = result.alreadyPresent ? 'already_present' : 'imported'; row.workId = result.workId; delete job.lease;
      if (!job.items.some(value => value.state === 'pending')) job.state = job.items.some(value => value.state === 'failed') ? 'partially_completed' : 'completed';
      this.store.put(key, job); return this.view(job);
    });
  }
}
module.exports = { BrowserExtensionService, BrowserExtensionError, SqliteBrowserStore, features, filterItems, remoteKey };
