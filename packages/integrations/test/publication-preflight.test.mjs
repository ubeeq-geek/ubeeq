import test from "node:test";
import assert from "node:assert/strict";
import { preflightIntegrationPublication as preflight } from "../dist/index.js";

const policy = (overrides = {}) => ({
  label: "Destination", announce: true, publish: { image: true, carousel: true },
  aiLabel: { carouselPrecision: "whole-carousel" }, limits: {}, ...overrides
});
const input = (overrides = {}) => ({ platform: "custom-destination", mediaTypes: ["image"], ...overrides });

test("caller capabilities distinguish announcements from publication and deduplicate media issues", () => {
  const limited = policy({ announce: false, publish: {} });
  assert.deepEqual(preflight(input({ mediaTypes: ["video", "video"] }), limited).issues.map(x => x.code),
    ["unsupported_operation", "unsupported_media"]);
  assert.deepEqual(preflight(input({ intent: "announce", mediaTypes: ["video"] }), limited).issues.map(x => x.code),
    ["unsupported_operation"]);
  assert.equal(preflight(input({ intent: "announce", mediaTypes: ["video"] }), policy()).ok, true);
  assert.equal(preflight(input(), policy({ limits: { rollout: { state: "configuration_required" } } })).ok, false);
});

test("injected media limits accept exact boundaries and wildcard MIME support", () => {
  const configured = policy({ limits: { media: { maximumItems: 2, maximumCaptionCharacters: 4,
    maximumBytes: 10, allowedMimeTypes: ["image/*"] } } });
  assert.equal(preflight(input({ itemCount: 2, caption: "1234", bytes: 10, mimeTypes: ["image/webp"] }), configured).ok, true);
  assert.deepEqual(preflight(input({ itemCount: 3, caption: "12345", bytes: 11, mimeTypes: ["application/pdf"] }), configured)
    .issues.map(x => x.code), ["maximum_items_exceeded", "caption_too_long", "unsupported_mime_type", "asset_too_large"]);
});

test("mixed disclosure precision is a warning selected by the supplied policy", () => {
  const mixed = input({ mediaTypes: ["carousel"], aiDisclosures: ["one", "two"] });
  const result = preflight(mixed, policy());
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues.map(x => [x.code, x.severity]), [["mixed_ai_carousel", "warning"]]);
  assert.equal(preflight(mixed, policy({ aiLabel: { carouselPrecision: "per-item" } })).issues.length, 0);
  assert.equal(preflight(input({ mediaTypes: ["carousel"], aiDisclosures: ["one", "one"] }), policy()).issues.length, 0);
});

test("admission evaluates connection, scopes, holds and injected attestations separately", () => {
  const configured = policy({ limits: { access: { requiresRightsAttestation: true, requiresAdultAttestation: true, requiresConsentAttestation: true } } });
  const unchecked = preflight(input(), configured);
  assert.equal(unchecked.admission.checked, false);
  const denied = preflight(input({ admission: { connectionState: "authentication_required",
    requiredScopes: ["write"], grantedScopes: ["read"], policyBlocked: true } }), configured);
  assert.equal(denied.static.ok, true); assert.equal(denied.admission.checked, true); assert.equal(denied.ok, false);
  assert.deepEqual(denied.admission.issues.map(x => x.code), ["account_not_ready", "missing_scope", "policy_blocked",
    "rights_attestation_required", "adult_attestation_required", "consent_attestation_required"]);
  assert.equal(preflight(input({ admission: { connectionState: "connected", requiredScopes: ["write"], grantedScopes: ["write"],
    rightsAttested: true, adultAttested: true, consentAttested: true } }), configured).ok, true);
});

test("projection preserves inputs and reports static plus admission failures in stable order", () => {
  const request = input({ itemCount: 2, admission: { connectionState: "rate_limited" } });
  const configured = policy({ limits: { media: { maximumItems: 1 } } });
  const before = structuredClone({ request, configured });
  const result = preflight(request, configured);
  assert.equal(result.platform, request.platform);
  assert.deepEqual(result.issues.map(x => x.code), ["maximum_items_exceeded", "account_not_ready"]);
  assert.deepEqual({ request, configured }, before);
});
