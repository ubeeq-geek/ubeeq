import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AI_FEATURES, type PolishTitleInput, type PolishTitleResult } from '@ubeeq/extension-sdk';

export interface AiVisibility { enabled: boolean; showAiAssistance: boolean; generation: number }
const AiContext = createContext<AiVisibility>({ enabled: false, showAiAssistance: false, generation: 0 });
/** All registered optional AI surfaces must render inside the same preference boundary. */
export function AiAssistanceProvider({ value, children }: { value: AiVisibility; children: ReactNode }) {
  return <AiContext.Provider value={value}>{children}</AiContext.Provider>;
}
export const AI_ASSISTANCE_CSS = `
.ubeeq-ai{--ai-ink:#634095;--ai-border:#9676bf;--ai-tint:#f4eefa;color:var(--ai-ink);background:var(--ai-tint);border:1px solid var(--ai-border);border-radius:.35rem;padding:.35rem .55rem;display:inline-flex;gap:.35rem;align-items:center;font:inherit;max-width:100%}
.ubeeq-ai svg{width:1.15em;height:1.15em;flex-shrink:0}.ubeeq-ai:focus-visible{outline:3px solid var(--ai-ink);outline-offset:3px}.ubeeq-ai-badge{font-size:.8em}.ubeeq-ai-comparison{overflow-wrap:anywhere;margin-block:.5rem}.ubeeq-ai-comparison button{margin-inline-end:.5rem}.ubeeq-ai-options{display:flex;flex-wrap:wrap;gap:.5rem}.ubeeq-ai-options input{max-width:100%}.ubeeq-ai-comparison strong{text-decoration:underline}
@media(prefers-color-scheme:dark){.ubeeq-ai{--ai-ink:#dcc6fa;--ai-border:#aa88d3;--ai-tint:#30233e}}
[data-color-scheme=dark] .ubeeq-ai,[data-theme=dark] .ubeeq-ai,.dark .ubeeq-ai{--ai-ink:#dcc6fa;--ai-border:#aa88d3;--ai-tint:#30233e}
[data-color-scheme=light] .ubeeq-ai,[data-theme=light] .ubeeq-ai{--ai-ink:#634095;--ai-border:#9676bf;--ai-tint:#f4eefa}
`;
export function AiBadge() { return <span className="ubeeq-ai-badge">AI</span>; }
export function AiAction({ pending, disabled, onClick }: { pending?: boolean; disabled?: boolean; onClick(): void }) {
  const visibility = useContext(AiContext);
  if (!visibility.enabled || !visibility.showAiAssistance) return null;
  const feature = AI_FEATURES['text.polish_title'];
  return <button type="button" className="ubeeq-ai" aria-label={feature.accessibleName} aria-busy={pending || undefined} disabled={pending || disabled} onClick={onClick}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M9 3 11.5 9.5 18 12 11.5 14.5 9 21 6.5 14.5 0 12 6.5 9.5Z"/><path d="m19 1 1.2 3.8L24 6l-3.8 1.2L19 11l-1.2-3.8L14 6l3.8-1.2Z"/></svg>
    {pending ? <span>Polishing…</span> : <span>{feature.label} · <AiBadge/></span>}
    {pending && <span aria-hidden="true">…</span>}
  </button>;
}
/** Word-level LCS diff, bounded by title input size. Plain React text escapes all model output. */
export function titleDiff(original: string, suggestion: string): { original: { text: string; changed: boolean }[]; suggestion: { text: string; changed: boolean }[] } {
  const a = original.split(/(\s+)/), b = suggestion.split(/(\s+)/);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const left = a.map(text => ({ text, changed: true })), right = b.map(text => ({ text, changed: true }));
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { left[i++].changed = false; right[j++].changed = false; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return { original: left, suggestion: right };
}
export interface TitlePolishControlProps {
  titleId: string;
  title: string;
  disabled?: boolean;
  /** Host performs authenticated server calls. No browser credentials/provider SDK. */
  client: {
    availability(titleId: string, signal: AbortSignal): Promise<{ available: boolean; remaining: number; permitted?: boolean }>;
    polish(titleId: string, input: PolishTitleInput, signal: AbortSignal): Promise<PolishTitleResult>;
    accepted?(titleId: string): void;
  };
  onApply(title: string): void;
}
export function TitlePolishControl(props: TitlePolishControlProps) {
  const visibility = useContext(AiContext);
  if (!visibility.enabled || !visibility.showAiAssistance) return null;
  return <VisibleTitlePolishControl {...props} generation={visibility.generation}/>;
}
function VisibleTitlePolishControl({ titleId, title, client, onApply, disabled, generation }: TitlePolishControlProps & { generation: number }) {
  const [casing, setCasing] = useState<PolishTitleInput['casing']>('preserve');
  const [language, setLanguage] = useState('auto');
  const [names, setNames] = useState('');
  const [allowance, setAllowance] = useState<{ available: boolean; remaining: number; permitted?: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [suggestion, setSuggestion] = useState<{ value: string; source: string; revision: number } | null>(null);
  const current = JSON.stringify([titleId, title, casing, language, names, generation, disabled]);
  const live = useRef({ source: current, revision: 0 });
  if (live.current.source !== current) live.current = { source: current, revision: live.current.revision + 1 };
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = (signal: AbortSignal) => client.availability(titleId, signal).then(value => { if (!signal.aborted) setAllowance(value); }).catch(() => { if (!signal.aborted) setAllowance(null); });
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController(); void refresh(controller.signal);
    return () => { mounted.current = false; controller.abort(); operation.current?.abort(); };
  }, [titleId, generation, client]);
  useEffect(() => {
    operation.current?.abort(); operation.current = null; setPending(false);
    setSuggestion(null); setMessage('');
  }, [current]);
  const run = async () => {
    if (operation.current || disabled || !title.trim() || title.length > 300) return;
    const controller = new AbortController(); operation.current = controller;
    const source = live.current.source, revision = live.current.revision;
    setPending(true); setMessage(''); setSuggestion(null);
    try {
      const result = await client.polish(titleId, { title, casing, language, preservedNames: names.split(',').map(v => v.trim()).filter(Boolean) }, controller.signal);
      if (controller.signal.aborted || source !== live.current.source || revision !== live.current.revision) return;
      if (result.status === 'changed' && result.suggestion.trim() && result.suggestion.length <= 300) setSuggestion({ value: result.suggestion, source, revision });
      else setMessage(result.status === 'unchanged' ? 'No changes suggested.' : result.status === 'needs_context' ? 'Needs context' : 'Could not polish this title. Please try again.');
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Could not polish this title. Please try again.');
    } finally {
      if (mounted.current && operation.current === controller) { setPending(false); operation.current = null; void refresh(controller.signal); }
    }
  };
  const diff = suggestion ? titleDiff(title, suggestion.value) : null;
  const words = (parts: { text: string; changed: boolean }[]) => parts.map((p, i) => p.changed ? <strong key={i}>{p.text}</strong> : <span key={i}>{p.text}</span>);
  if (!allowance || allowance.permitted === false) return null;
  return <div className="ubeeq-ai-editor">
    <style>{AI_ASSISTANCE_CSS}</style>
    <details><summary>AI options</summary><div className="ubeeq-ai-options">
      <label>AI casing <select value={casing} disabled={pending || disabled} onChange={e => setCasing(e.target.value as PolishTitleInput['casing'])}><option value="preserve">Preserve case</option><option value="title">Title case</option><option value="sentence">Sentence case</option></select></label>
      <label>Title language <input value={language} maxLength={64} disabled={pending || disabled} onChange={e => setLanguage(e.target.value)}/></label>
      <label>Preserved names (comma separated)<input value={names} maxLength={1000} disabled={pending || disabled} onChange={e => setNames(e.target.value)}/></label>
    </div></details>
    <AiAction pending={pending} disabled={disabled || !title.trim() || title.length > 300 || !language.trim() || allowance?.available === false} onClick={() => void run()}/>
    {allowance?.remaining === 0 && <p role="status">Polish limit reached for this title.</p>}
    {allowance && allowance.remaining > 0 && !allowance.available && <p role="status">AI allowance unavailable.</p>}
    {message && <p role="status">{message}</p>}
    {suggestion && diff && <div className="ubeeq-ai-comparison" role="region" aria-label="AI suggestion">
      <p>Original: {words(diff.original)}</p><p>AI suggestion: {words(diff.suggestion)}</p>
      <button type="button" disabled={disabled} onClick={() => {
        if (suggestion.source !== live.current.source || suggestion.revision !== live.current.revision) { setSuggestion(null); setMessage('Title changed. Run a fresh polish.'); return; }
        onApply(suggestion.value); try { client.accepted?.(titleId); } catch { /* Analytics never block editing. */ } setSuggestion(null);
      }}>Apply</button><button type="button" onClick={() => setSuggestion(null)}>Dismiss</button>
    </div>}
  </div>;
}
