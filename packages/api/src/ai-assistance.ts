import { createHash } from 'node:crypto';
import { validatePolishTitleInput, validatePolishTitleResult, type PolishTitleInput, type PolishTitleResult, type TitlePolishProvider } from '@ubeeq/extension-sdk';

export interface AiPrincipal { tenantId: string; userId: string }
export interface AiDocument<T> { revision: number; value: T }
export interface AiWrite { key: string; revision: number | null; value: unknown }
/** Durable, shared by all workers/devices. commit MUST compare every revision and write atomically.
 * Bind to one instance; use the same identity/preference store across linked products. Never use process-local locks for quotas. */
export interface AiAssistanceStore {
  get<T>(key: string): Promise<AiDocument<T> | null>;
  commit(writes: readonly AiWrite[]): Promise<boolean>;
}
export interface AiPreference { showAiAssistance: boolean; generation: number }
export interface AiAssistanceConfiguration {
  enabled?: boolean;
  perTitleLimit?: number;
  perUserDailyLimit: number;
  instanceDailyBudgetUsd: number;
  /** Prices must be checked at rollout. Reserve worst-case cost before calling the provider. */
  maxRequestCostUsd: number;
  timeoutMs?: number;
  cacheTtlMs?: number;
}
export interface AiAssistancePorts {
  store: AiAssistanceStore;
  provider?: TitlePolishProvider;
  /** Must recheck edit permission for the authenticated principal and stable title ID. */
  canEdit(p: AiPrincipal, titleId: string): Promise<boolean>;
  /** Metadata only. Never log titles, context, suggestions, or provider error bodies. */
  observe?(event: { outcome: string; latencyMs: number; inputTokens?: number; outputTokens?: number }): void;
  now?(): number;
}
export class AiAssistanceError extends Error {
  constructor(readonly code: 'disabled' | 'denied' | 'limit' | 'conflict' | 'unavailable' | 'invalid', message: string) { super(message); }
}
const key = (...parts: string[]) => JSON.stringify(parts);
const fail = (code: AiAssistanceError['code'], message: string): never => { throw new AiAssistanceError(code, message); };
const validId = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256;
interface Counter { count: number }
interface Budget { reservedUsd: number }
interface Cache { result: PolishTitleResult; expiresAt: number }

/** Optional server service: construct only in an explicitly configured host. No inference on preference reads. */
export class AiAssistanceService {
  private readonly now: () => number;
  private readonly titleLimit: number;
  private readonly timeout: number;
  constructor(private readonly config: AiAssistanceConfiguration, private readonly ports: AiAssistancePorts) {
    this.now = ports.now ?? Date.now;
    this.titleLimit = config.perTitleLimit ?? 3;
    this.timeout = config.timeoutMs ?? 10000;
    if (![this.titleLimit, config.perUserDailyLimit, this.timeout].every(v => Number.isSafeInteger(v) && v > 0) ||
      !Number.isFinite(config.instanceDailyBudgetUsd) || config.instanceDailyBudgetUsd <= 0 ||
      !Number.isFinite(config.maxRequestCostUsd) || config.maxRequestCostUsd <= 0 ||
      (config.cacheTtlMs !== undefined && (!Number.isFinite(config.cacheTtlMs) || config.cacheTtlMs < 0))) throw new Error('Invalid AI limits.');
  }
  private principal(p: AiPrincipal) {
    if (!p || !validId(p.tenantId) || !validId(p.userId)) fail('denied', 'Authentication required.');
  }
  private preferenceKey(p: AiPrincipal) { return key('ai.preference', p.tenantId, p.userId); }
  async preference(p: AiPrincipal): Promise<AiPreference> {
    this.principal(p);
    return (await this.ports.store.get<AiPreference>(this.preferenceKey(p)))?.value ?? { showAiAssistance: false, generation: 0 };
  }
  /** Explicit migration: initialize hosted users to true, without overwriting existing choices. */
  async initializePreference(p: AiPrincipal, showAiAssistance: boolean): Promise<void> {
    this.principal(p);
    if (typeof showAiAssistance !== 'boolean') fail('invalid', 'Invalid preference.');
    await this.ports.store.commit([{ key: this.preferenceKey(p), revision: null, value: { showAiAssistance, generation: 1 } }]);
  }
  async setPreference(p: AiPrincipal, showAiAssistance: boolean): Promise<AiPreference> {
    this.principal(p);
    if (typeof showAiAssistance !== 'boolean') fail('invalid', 'Invalid preference.');
    for (let attempt = 0; attempt < 8; attempt++) {
      const old = await this.ports.store.get<AiPreference>(this.preferenceKey(p));
      const value = { showAiAssistance, generation: (old?.value.generation ?? 0) + 1 };
      if (await this.ports.store.commit([{ key: this.preferenceKey(p), revision: old?.revision ?? null, value }])) return value;
    }
    return fail('conflict', 'Preference changed. Please retry.');
  }
  private async allowed(p: AiPrincipal, titleId: string) {
    this.principal(p);
    if (!validId(titleId)) fail('invalid', 'Invalid title reference.');
    if (!this.config.enabled || !this.ports.provider) fail('disabled', 'AI assistance is unavailable.');
    const preference = await this.preference(p);
    if (!preference.showAiAssistance) fail('disabled', 'AI assistance is off.');
    if (!await this.ports.canEdit(p, titleId)) fail('denied', 'Title editing is not allowed.');
    return preference;
  }
  async availability(p: AiPrincipal, titleId: string): Promise<{ available: boolean; remaining: number; permitted: boolean }> {
    try {
      await this.allowed(p, titleId);
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const [title, user, budget] = await Promise.all([
        this.ports.store.get<Counter>(key('ai.title', p.tenantId, titleId)),
        this.ports.store.get<Counter>(key('ai.user', p.tenantId, p.userId, day)),
        this.ports.store.get<Budget>(key('ai.budget', day))
      ]);
      const remaining = Math.max(0, this.titleLimit - (title?.value.count ?? 0));
      return { permitted: true, available: remaining > 0 && (user?.value.count ?? 0) < this.config.perUserDailyLimit &&
        (budget?.value.reservedUsd ?? 0) + this.config.maxRequestCostUsd <= this.config.instanceDailyBudgetUsd, remaining };
    } catch (error) { if (error instanceof AiAssistanceError) return { permitted: false, available: false, remaining: 0 }; throw error; }
  }
  async polishTitle(p: AiPrincipal, titleId: string, input: PolishTitleInput, signal?: AbortSignal): Promise<PolishTitleResult> {
    const preference = await this.allowed(p, titleId);
    try { validatePolishTitleInput(input); } catch { return fail('invalid', 'Invalid title polishing input.'); }
    // Snapshot caller-owned objects before any asynchronous operation.
    input = structuredClone(input);
    if (signal?.aborted) return fail('unavailable', 'Polishing cancelled.');
    const started = this.now();
    const day = new Date(started).toISOString().slice(0, 10);
    const titleKey = key('ai.title', p.tenantId, titleId);
    const userKey = key('ai.user', p.tenantId, p.userId, day);
    const budgetKey = key('ai.budget', day);
    const cacheKey = key('ai.cache', p.tenantId, p.userId, createHash('sha256').update(JSON.stringify([this.ports.provider!.identity, input])).digest('hex'));
    const cache = await this.ports.store.get<Cache>(cacheKey);
    const cached = cache && cache.value.expiresAt > started ? cache.value.result : undefined;
    let reserved = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const [pref, title, user, budget] = await Promise.all([
        this.ports.store.get<AiPreference>(this.preferenceKey(p)), this.ports.store.get<Counter>(titleKey),
        this.ports.store.get<Counter>(userKey), this.ports.store.get<Budget>(budgetKey)
      ]);
      if (!pref?.value.showAiAssistance || pref.value.generation !== preference.generation) return fail('disabled', 'AI assistance preference changed.');
      if ((title?.value.count ?? 0) >= this.titleLimit) return fail('limit', 'Polish limit reached for this title.');
      if ((user?.value.count ?? 0) >= this.config.perUserDailyLimit) return fail('limit', 'Daily AI allowance reached.');
      const cost = cached ? 0 : this.config.maxRequestCostUsd;
      if ((budget?.value.reservedUsd ?? 0) + cost > this.config.instanceDailyBudgetUsd) return fail('limit', 'AI assistance budget reached.');
      if (await this.ports.store.commit([
        { key: this.preferenceKey(p), revision: pref.revision, value: pref.value },
        { key: titleKey, revision: title?.revision ?? null, value: { count: (title?.value.count ?? 0) + 1 } },
        { key: userKey, revision: user?.revision ?? null, value: { count: (user?.value.count ?? 0) + 1 } },
        { key: budgetKey, revision: budget?.revision ?? null, value: { reservedUsd: (budget?.value.reservedUsd ?? 0) + cost } }
      ])) { reserved = true; break; }
    }
    if (!reserved) return fail('conflict', 'AI allowance changed. Please retry.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const preferencePoll = setInterval(() => {
      void this.preference(p).then(current => { if (!current.showAiAssistance || current.generation !== preference.generation) controller.abort(); }).catch(() => controller.abort());
    }, 250);
    if (signal?.aborted) controller.abort();
    try {
      if (controller.signal.aborted) return fail('unavailable', 'Polishing cancelled.');
      const result = cached ?? await Promise.race([
        this.ports.provider!.polishTitle(input, controller.signal).then(response => {
          if (controller.signal.aborted) throw new Error('Cancelled.');
          if (![response.inputTokens, response.outputTokens].every(v => Number.isSafeInteger(v) && v >= 0)) throw new Error('Invalid usage.');
          const result = validatePolishTitleResult(response.result, input.title);
          this.observe({ outcome: result.status, latencyMs: this.now() - started, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
          return result;
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true });
          timer = setTimeout(() => { controller.abort(); }, this.timeout);
        })
      ]);
      const current = await this.allowed(p, titleId);
      if (current.generation !== preference.generation || signal?.aborted || controller.signal.aborted) return fail('disabled', 'AI result discarded.');
      if (!cached && (this.config.cacheTtlMs ?? 300000) > 0) await this.ports.store.commit([{ key: cacheKey, revision: cache?.revision ?? null, value: { result, expiresAt: this.now() + (this.config.cacheTtlMs ?? 300000) } }]);
      return result;
    } catch (error) {
      this.observe({ outcome: error instanceof AiAssistanceError ? error.code : error instanceof Error && error.name === 'AiRefusalError' ? 'refusal' : 'failure', latencyMs: this.now() - started });
      if (error instanceof AiAssistanceError) throw error;
      return fail('unavailable', 'Could not polish this title. Please try again.');
    } finally { clearInterval(preferencePoll); if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async recordAcceptance(p: AiPrincipal, titleId: string): Promise<void> {
    await this.allowed(p, titleId);
    this.observe({ outcome: 'accepted', latencyMs: 0 });
  }
  private observe(event: Parameters<NonNullable<AiAssistancePorts['observe']>>[0]) {
    try { this.ports.observe?.(event); } catch { /* Telemetry cannot affect editing. */ }
  }
}
