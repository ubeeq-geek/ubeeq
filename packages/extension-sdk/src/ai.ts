/** Optional AI is separate from mandatory moderation/security policy. No provider is enabled by this contract. */
export const AI_FEATURES = Object.freeze({
  'text.polish_title': { label: 'Polish title', accessibleName: 'Polish title with AI' }
});
export type AiCapability = keyof typeof AI_FEATURES;
export type TitleCasing = 'title' | 'sentence' | 'preserve';
export interface PolishTitleInput {
  title: string;
  casing: TitleCasing;
  language: string;
  preservedNames: readonly string[];
  /** Only include when the caller knows context is needed. Never send a whole description. */
  context?: string;
}
export type PolishTitleResult = { status: 'changed'; suggestion: string } | { status: 'unchanged' | 'needs_context' };
export interface AiProviderResult {
  result: unknown;
  inputTokens: number;
  outputTokens: number;
}
export interface TitlePolishProvider {
  /** Include profile and prompt version in identity; used to partition cache entries. */
  readonly identity: string;
  polishTitle(input: PolishTitleInput, signal: AbortSignal): Promise<AiProviderResult>;
}
export function validatePolishTitleInput(input: PolishTitleInput): void {
  const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (!input || Object.keys(input).some(k => !['title', 'casing', 'language', 'preservedNames', 'context'].includes(k)) || !text(input.title, 500) || !['title', 'sentence', 'preserve'].includes(input.casing) ||
      !text(input.language, 64) || !Array.isArray(input.preservedNames) || input.preservedNames.length > 32 ||
      !input.preservedNames.every(v => text(v, 100)) ||
      (input.context !== undefined && !text(input.context, 1500))) throw new Error('Invalid title polishing input.');
}
export function validatePolishTitleResult(value: unknown, source: string): PolishTitleResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AI result.');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(k => !['status', 'suggestion'].includes(k))) throw new Error('Invalid AI result fields.');
  if (result.status === 'changed' && typeof result.suggestion === 'string' && result.suggestion.trim() && result.suggestion.length <= 500 && !/[\r\n\u0000-\u001f]/.test(result.suggestion)) {
    return result.suggestion === source ? { status: 'unchanged' } : { status: 'changed', suggestion: result.suggestion };
  }
  if ((result.status === 'unchanged' || result.status === 'needs_context') && result.suggestion === undefined) return { status: result.status };
  throw new Error('Invalid AI result.');
}
