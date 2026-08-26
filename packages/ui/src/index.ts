export interface LocalizedText { defaultLocale: string; translations: Readonly<Record<string, string>>; }
export interface AccessibleAction { id: string; label: LocalizedText; description?: LocalizedText; }
export type UiTokens = Readonly<Record<string, string>>;

export const validateUiTokens = (tokens: UiTokens): UiTokens => {
  for (const [name, value] of Object.entries(tokens)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !value.trim()) throw new Error(`Invalid UI token: ${name}`);
  }
  return tokens;
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
