import type { ContentBlock } from "./index.js";
import { validateContentBlocks } from "./index.js";
import { announcementDestinationKey, assertAnnouncementId, AnnouncementOrchestrationError } from "./announcement-orchestration.js";
import type { AnnouncementDestinationBinding, AnnouncementScope } from "./announcement-orchestration.js";
import type { CollectionReleaseReadinessRule } from "./collection-release-readiness.js";
import { isDurableAnnouncementUrl } from "./collection-release-readiness.js";
import type { AnnouncementTiming, AnnouncementFollowUpTiming, AnnouncementLatePolicy } from "./announcement-plan-scheduler.js";
import { validateAnnouncementTiming, validateAnnouncementLatePolicy } from "./announcement-plan-scheduler.js";

export const ANNOUNCEMENT_TEMPLATE_VARIABLES = ["collection.title", "collection.description", "creator.name", "release.kind", "release.newWorkCount", "release.totalPublishedWorkCount", "release.publishedAt", "primaryLink.url", "primaryLink.label"] as const;
export type AnnouncementTemplateVariable = typeof ANNOUNCEMENT_TEMPLATE_VARIABLES[number];
export type AnnouncementTemplateValues = Partial<Record<AnnouncementTemplateVariable, string | number>>;
export interface AnnouncementTemplate {
  blocks: readonly ContentBlock[];
  /** Keys identify complete destination bindings, never provider names alone. */
  destinationOverrides?: Readonly<Record<string, readonly ContentBlock[]>>;
}
export interface AnnouncementDestinationSelection {
  binding: AnnouncementDestinationBinding;
  settings: Readonly<Record<string, unknown>>;
}
export type AnnouncementMediaSelection =
  | { mode: "none" }
  | { mode: "cover"; altText: string; caption?: string }
  | { mode: "managed_previews"; assets: readonly { assetId: string; altText: string; caption?: string }[] };
export interface AnnouncementContentLinkBinding { destinationKey: string; label: string }
export interface AnnouncementFollowUpPreferences {
  enabled: boolean;
  template: AnnouncementTemplate;
  destinations: readonly AnnouncementDestinationSelection[];
  media: AnnouncementMediaSelection;
  timing: AnnouncementFollowUpTiming;
  latePolicy: AnnouncementLatePolicy;
}
export interface CollectionAnnouncementTriggerPreferences {
  behaviour: "off" | "draft" | "automatic";
  template: AnnouncementTemplate;
  destinations: readonly AnnouncementDestinationSelection[];
  media: AnnouncementMediaSelection;
  links: { primary?: AnnouncementContentLinkBinding; secondary: readonly AnnouncementContentLinkBinding[] };
  completion: CollectionReleaseReadinessRule;
  timing: AnnouncementTiming;
  latePolicy: AnnouncementLatePolicy;
  followUp?: AnnouncementFollowUpPreferences;
}
export interface CollectionAnnouncementPreferences {
  schemaVersion: 1;
  initial: CollectionAnnouncementTriggerPreferences;
  additions: CollectionAnnouncementTriggerPreferences;
}
/** Missing or null groups inherit. Replacing an array never merges destinations by provider. */
export type CollectionAnnouncementTriggerPatch = { [K in keyof CollectionAnnouncementTriggerPreferences]?: CollectionAnnouncementTriggerPreferences[K] | null };
export interface CollectionAnnouncementPreferencePatch {
  initial?: CollectionAnnouncementTriggerPatch;
  additions?: CollectionAnnouncementTriggerPatch;
}
export interface AnnouncementPreferenceSet extends Pick<AnnouncementScope, "tenantId" | "creatorId"> {
  schemaVersion: 1;
  collectionId?: string;
  revision: number;
  actorId: string;
  settings: CollectionAnnouncementPreferences | CollectionAnnouncementPreferencePatch;
  createdAt: string;
  updatedAt: string;
}
export interface EffectiveCollectionAnnouncementPreferences {
  schemaVersion: 1;
  settings: CollectionAnnouncementPreferences;
  contributingRevisions: { creator: number; collection?: number; release?: number };
  inheritance: Record<"initial" | "additions", Partial<Record<keyof CollectionAnnouncementTriggerPreferences, "creator" | "collection" | "release">>>;
}
const templateFields = ["text", "title", "label", "caption", "quote", "author", "url"] as const;
const allowedVariables = new Set<string>(ANNOUNCEMENT_TEMPLATE_VARIABLES);
function variables(text: string): string[] {
  const found: string[] = [];
  const remainder = text.replace(/\{\{([^{}]+)\}\}/g, (_match, variable: string) => {
    if (!allowedVariables.has(variable)) throw new AnnouncementOrchestrationError("INVALID_INPUT", `Unknown announcement variable: ${variable}. Choose a supported template variable.`);
    found.push(variable); return "";
  });
  if (remainder.includes("{{") || remainder.includes("}}"))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Use fixed {{variable.name}} substitutions without expressions.");
  return found;
}
function validateTemplateBlocks(blocks: readonly ContentBlock[]): void {
  validateContentBlocks(blocks);
  const visit = (items: readonly ContentBlock[], depth: number) => {
    if (depth > 16) throw new AnnouncementOrchestrationError("INVALID_INPUT", "Announcement templates are nested too deeply.");
    for (const b of items) {
      // Opaque data/HTML cannot be interpolated. Keep templates in explicitly typed fields.
      for (const [key, value] of Object.entries(b)) {
        if (key === "children") continue;
        if (templateFields.includes(key as typeof templateFields[number]) && typeof value === "string") variables(value);
        else if (/\{\{|\}\}/.test(JSON.stringify(value) ?? "")) throw new AnnouncementOrchestrationError("INVALID_INPUT", "Template variables may only appear in typed text or link fields.");
      }
      if (b.url !== undefined && b.url !== "{{primaryLink.url}}" && (!isDurableAnnouncementUrl(b.url) || variables(b.url).length))
        throw new AnnouncementOrchestrationError("INVALID_INPUT", "Use a durable content link or the complete primaryLink.url binding.");
      if (b.children) visit(b.children, depth + 1);
    }
  };
  if (new TextEncoder().encode(JSON.stringify(blocks)).length > 200000)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Announcement templates must be bounded.");
  visit(blocks, 0);
}
export function validateAnnouncementTemplate(template: AnnouncementTemplate): void {
  validateTemplateBlocks(template.blocks);
  for (const blocks of Object.values(template.destinationOverrides ?? {})) validateTemplateBlocks(blocks);
}
/** Values stay inert. The existing renderer and provider block validators remain mandatory. */
export function renderAnnouncementTemplate(input: {
  template: AnnouncementTemplate;
  values: AnnouncementTemplateValues;
  destinationKey?: string;
  /** Shared counts are forbidden when primary destination scopes differ. */
  sharedCountsAvailable?: boolean;
}): ContentBlock[] {
  validateAnnouncementTemplate(input.template);
  const blocks = input.destinationKey && input.template.destinationOverrides?.[input.destinationKey] || input.template.blocks;
  const replace = (text: string): string => {
    variables(text);
    return text.replace(/\{\{([^{}]+)\}\}/g, (_match, name: AnnouncementTemplateVariable) => {
      if (input.sharedCountsAvailable === false && ["release.newWorkCount", "release.totalPublishedWorkCount"].includes(name))
        throw new AnnouncementOrchestrationError("REVIEW_REQUIRED", "Destination release scopes differ. Supply destination-specific counts or remove the count variable.");
      const value = input.values[name];
      if (value === undefined || (typeof value !== "string" && typeof value !== "number") || (typeof value === "number" && !Number.isFinite(value)))
        throw new AnnouncementOrchestrationError("INVALID_INPUT", `Resolve ${name} from confirmed release evidence before preparing the announcement.`);
      if (name === "primaryLink.url" && !isDurableAnnouncementUrl(value))
        throw new AnnouncementOrchestrationError("LINK_NOT_READY", "Resolve a durable, credential-free primary content link before preparing this announcement.");
      if (["release.newWorkCount", "release.totalPublishedWorkCount"].includes(name) && (!Number.isSafeInteger(value) || Number(value) < 0))
        throw new AnnouncementOrchestrationError("INVALID_INPUT", "Announcement work counts must be confirmed nonnegative integers.");
      return String(value);
    });
  };
  const visit = (items: readonly ContentBlock[]): ContentBlock[] => items.map(original => {
    const b = structuredClone(original);
    for (const field of templateFields) if (typeof b[field] === "string") b[field] = replace(b[field]!);
    if (b.url !== undefined && !isDurableAnnouncementUrl(b.url))
      throw new AnnouncementOrchestrationError("LINK_NOT_READY", "Resolve a durable, credential-free content link before preparing this announcement.");
    if (b.children) b.children = visit(b.children);
    return b;
  });
  return visit(blocks);
}
function validateDestinations(destinations: readonly AnnouncementDestinationSelection[], active: boolean): void {
  const keys = destinations.map(d => announcementDestinationKey(d.binding));
  if ((active && !keys.length) || keys.length > 100 || new Set(keys).size !== keys.length)
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Select distinct announcement destinations before enabling this trigger.");
}
function validateMedia(media: AnnouncementMediaSelection): void {
  if (!media || !["none", "cover", "managed_previews"].includes(media.mode))
    throw new AnnouncementOrchestrationError("INVALID_INPUT", "Select a cover, managed previews, or no media.");
  if (media.mode === "managed_previews") {
    if (!media.assets.length || media.assets.length > 50 || new Set(media.assets.map(a => a.assetId)).size !== media.assets.length)
      throw new AnnouncementOrchestrationError("INVALID_INPUT", "Select a bounded set of distinct managed preview assets.");
    media.assets.forEach(a => assertAnnouncementId(a.assetId));
  }
}
export function validateCollectionAnnouncementPreferences(settings: CollectionAnnouncementPreferences): void {
  if (settings.schemaVersion !== 1) throw new AnnouncementOrchestrationError("INVALID_INPUT", "Unsupported announcement preferences version.");
  for (const trigger of [settings.initial, settings.additions]) {
    if (!["off", "draft", "automatic"].includes(trigger.behaviour)) throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose off, draft or automatic announcement behaviour.");
    validateAnnouncementTemplate(trigger.template); validateDestinations(trigger.destinations, trigger.behaviour !== "off");
    validateMedia(trigger.media); validateAnnouncementTiming(trigger.timing); validateAnnouncementLatePolicy(trigger.latePolicy);
    if (!["all_required", "primary_destination"].includes(trigger.completion.mode)) throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a publication completion rule.");
    if (trigger.completion.mode === "primary_destination") assertAnnouncementId(trigger.completion.destinationKey);
    if (trigger.behaviour !== "off" && !trigger.links.primary) throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose the primary content destination before enabling announcements.");
    for (const link of [trigger.links.primary, ...trigger.links.secondary].filter((l): l is AnnouncementContentLinkBinding => Boolean(l))) {
      assertAnnouncementId(link.destinationKey); assertAnnouncementId(link.label);
    }
    const destinationKeys = trigger.destinations.map(d => announcementDestinationKey(d.binding));
    for (const key of Object.keys(trigger.template.destinationOverrides ?? {})) if (!destinationKeys.includes(key))
      throw new AnnouncementOrchestrationError("INVALID_INPUT", "Template overrides must identify a selected announcement destination.");
    const f = trigger.followUp;
    if (f) {
      validateAnnouncementTemplate(f.template); validateDestinations(f.destinations, f.enabled); validateMedia(f.media);
      validateAnnouncementTiming(f.timing); validateAnnouncementLatePolicy(f.latePolicy);
      const anchor = f.timing.anchor;
      if (!["corresponding_destination", "first_successful_initial_delivery", "parent_destination"].includes(anchor.mode)
        || (f.enabled && anchor.mode === "corresponding_destination" && f.destinations.some(d => !destinationKeys.includes(announcementDestinationKey(d.binding))))
        || (f.enabled && anchor.mode === "parent_destination" && !destinationKeys.includes(anchor.destinationKey)))
        throw new AnnouncementOrchestrationError("INVALID_INPUT", "Choose a valid initial delivery anchor for every follow-up destination.");
    }
  }
}
/** Each group is replaced as a unit. Null restores live inheritance rather than freezing a copied default. */
export function resolveCollectionAnnouncementPreferences(input: {
  creator: { revision: number; settings: CollectionAnnouncementPreferences };
  collection?: { revision: number; patch: CollectionAnnouncementPreferencePatch };
  release?: { revision: number; patch: CollectionAnnouncementPreferencePatch };
}): EffectiveCollectionAnnouncementPreferences {
  const settings = structuredClone(input.creator.settings);
  const inheritance: EffectiveCollectionAnnouncementPreferences["inheritance"] = { initial: {}, additions: {} };
  for (const revision of [input.creator.revision, input.collection?.revision, input.release?.revision])
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new AnnouncementOrchestrationError("INVALID_INPUT", "Preference revisions must be positive integers.");
  for (const kind of ["initial", "additions"] as const) {
    const trigger = settings[kind];
    for (const key of Object.keys(trigger) as Array<keyof CollectionAnnouncementTriggerPreferences>) inheritance[kind][key] = "creator";
    for (const [source, patch] of [["collection", input.collection?.patch[kind]], ["release", input.release?.patch[kind]]] as const) {
      if (!patch) continue;
      for (const [key, value] of Object.entries(patch)) {
        if (!["behaviour", "template", "destinations", "media", "links", "completion", "timing", "latePolicy", "followUp"].includes(key))
          throw new AnnouncementOrchestrationError("INVALID_INPUT", `Unknown preference group: ${key}.`);
        if (value === undefined || value === null) continue;
        Object.assign(trigger, { [key]: structuredClone(value) });
        inheritance[kind][key as keyof CollectionAnnouncementTriggerPreferences] = source;
      }
    }
  }
  validateCollectionAnnouncementPreferences(settings);
  return { schemaVersion: 1, settings, inheritance,
    contributingRevisions: { creator: input.creator.revision, collection: input.collection?.revision, release: input.release?.revision } };
}
/** New identities are inert until explicit configuration authorizes future rules. */
export function defaultCollectionAnnouncementPreferences(timeZone: string): CollectionAnnouncementPreferences {
  const trigger = (text: string): CollectionAnnouncementTriggerPreferences => ({ behaviour: "off",
    template: { blocks: [{ id: "announcement-text" as ContentBlock["id"], type: "paragraph", text }] }, destinations: [], media: { mode: "none" },
    links: { secondary: [] }, completion: { mode: "all_required" }, timing: { mode: "after_publication", timeZone },
    latePolicy: { mode: "hold", maximumLatenessMs: 86400000 } });
  const settings: CollectionAnnouncementPreferences = { schemaVersion: 1,
    initial: trigger("Now available: {{collection.title}} — {{primaryLink.url}}"), additions: trigger("Added {{release.newWorkCount}} new works to {{collection.title}} — {{primaryLink.url}}") };
  validateCollectionAnnouncementPreferences(settings);
  return settings;
}
