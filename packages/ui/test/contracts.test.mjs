import assert from "node:assert/strict";
import test from "node:test";
import { UBEeq_REFERENCE_TOKENS, resolveLocalizedText, uiThemeCssVariables, validateAccessibleAction, validateUiThemeExtension, validateUiTokens } from "../dist/index.js";

test("resolves neutral localization with language and default fallbacks", () => {
  const text = { defaultLocale: "en", translations: { en: "Continue", fr: "Continuer" } };
  assert.equal(resolveLocalizedText(text, "fr-CA"), "Continuer");
  assert.equal(resolveLocalizedText(text, "de"), "Continue");
});

test("validates presentation tokens and accessible action labels", () => {
  assert.deepEqual(validateUiTokens({ "surface-primary": "#fff" }), { "surface-primary": "#fff" });
  assert.throws(() => validateUiTokens({ "Surface": "#fff" }));
  assert.throws(() => validateAccessibleAction({ id: "action", label: { defaultLocale: "en", translations: {} } }));
});

test("keeps public reference tokens semantic and permits private theme extensions", () => {
  assert.equal(UBEeq_REFERENCE_TOKENS["color-action"], "#5980a6");
  const theme = validateUiThemeExtension({ tokens: { "color-action": "#111111" }, density: "relaxed" });
  assert.equal(uiThemeCssVariables(theme), "--ubeeq-color-action:#111111");
});
