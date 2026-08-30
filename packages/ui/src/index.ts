export interface LocalizedText { defaultLocale: string; translations: Readonly<Record<string, string>>; }
export interface AccessibleAction { id: string; label: LocalizedText; description?: LocalizedText; }
export type UiTokens = Readonly<Record<string, string>>;

/**
 * Framework-neutral semantic theme contract. Public Ubeeq owns these slots;
 * a private product maps them to its own visual language without putting a
 * product selector or brand value in the public package.
 */
export type UiThemeExtension = Readonly<{
  tokens: UiTokens;
  componentRadius?: "technical" | "soft" | "editorial";
  density?: "compact" | "standard" | "relaxed";
}>;

export const UBEeq_REFERENCE_TOKENS: UiTokens = Object.freeze({
  "color-canvas": "#f2f2f3",
  "color-surface": "transparent",
  "color-surface-raised": "#e9e9ea",
  "color-text": "#1d1f20",
  "color-text-muted": "#5d5d60",
  "color-border": "rgba(29,31,32,.16)",
  "color-action": "#5980a6",
  "color-action-hover": "#416180",
  "color-focus": "#5980a6",
  "color-success": "#41738f",
  "color-warning": "#a6805a",
  "color-danger": "#a6595c",
  "font-body": "Barlow, system-ui, sans-serif",
  "font-display": "Barlow Condensed, system-ui, sans-serif",
  "space-1": "4px",
  "space-2": "8px",
  "space-3": "12px",
  "space-4": "16px",
  "radius-control": "0px",
  "radius-surface": "0px",
  "shadow-raised": "none",
  "motion-fast": "120ms",
  "motion-standard": "180ms"
});

export const validateUiTokens = (tokens: UiTokens): UiTokens => {
  for (const [name, value] of Object.entries(tokens)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !value.trim()) throw new Error(`Invalid UI token: ${name}`);
  }
  return tokens;
};

export const validateUiThemeExtension = (theme: UiThemeExtension): UiThemeExtension => {
  validateUiTokens(theme.tokens);
  return theme;
};

/** Serializes token maps for server-rendered reference apps and non-React consumers. */
export const uiThemeCssVariables = (theme: UiThemeExtension | UiTokens): string => {
  const candidate = theme as UiThemeExtension;
  const tokens: UiTokens = candidate.tokens && typeof candidate.tokens === "object" ? candidate.tokens : theme as UiTokens;
  validateUiTokens(tokens);
  return Object.entries(tokens).map(([name, value]) => `--ubeeq-${name}:${value}`).join(";");
};

/** Resolves content without embedding product copy or selecting a brand. */
export const resolveLocalizedText = (text: LocalizedText, locale: string): string => {
  const exact = text.translations[locale];
  const language = text.translations[locale.split("-")[0]];
  const fallback = text.translations[text.defaultLocale];
  if (!text.defaultLocale.trim() || !fallback?.trim()) throw new Error("Localized text requires a default-locale translation");
  return exact ?? language ?? fallback;
};

export const validateAccessibleAction = (action: AccessibleAction): AccessibleAction => {
  if (!/^[a-z][a-z0-9-]*$/.test(action.id)) throw new Error("Accessible action id is invalid");
  resolveLocalizedText(action.label, action.label.defaultLocale);
  if (action.description) resolveLocalizedText(action.description, action.description.defaultLocale);
  return action;
};
