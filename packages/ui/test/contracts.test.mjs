import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocalizedText, validateAccessibleAction, validateUiTokens } from "../dist/index.js";

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
