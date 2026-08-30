# Ubeeq Product UI Mockup Specification

**Status:** Proposed  
**Audience:** Ubeeq maintainers, Eversally product team, Nightframe product team, and design collaborators  
**Purpose:** Define the mockups and design-system artifacts needed to implement a coherent Ubeeq reference UI and distinct private Eversally and Nightframe product UIs without putting product branding or policy into public Ubeeq.

## 1. Decision

Ubeeq supplies accessible, brand-neutral UI primitives and application patterns. Eversally and Nightframe supply private theme extensions and product components that compose those primitives.

```text
@ubeeq/ui
  tokens, accessibility, component contracts, neutral application patterns
       │
       ├── @eversally/ui (private)
       │     Eversally tokens, components, navigation, copy, imagery
       │
       └── @nightframe/ui (private)
             Nightframe tokens, components, navigation, copy, imagery
```

This is not a runtime product switch in Ubeeq. A product application imports Ubeeq primitives and its own private UI package. Public Ubeeq must never import, select, or default to either product theme.

## 2. Design-system ownership

| Layer | Ubeeq owns | Product owns |
| --- | --- | --- |
| Foundations | Semantic token names, accessibility requirements, responsive rules, localization interfaces | Colour values, typography, spacing scale, imagery, motion character |
| Primitives | Button, input, field, dialog, menu, tabs, table, status, empty state, loading state, toast, page shell contracts | Visual variants, illustrations, icon selection, product-specific composite controls |
| Application patterns | Upload state, job state, moderation/admission state, work/asset list patterns, export/import, error envelope presentation | Information architecture, copy, discovery, eligibility, billing, content policy and product workflow choices |
| Brand | None beyond neutral “Ubeeq” reference materials | Names, marks, voice, themes, navigation, marketing, product-specific interactions |

## 3. Required token model

Mockups must identify values through semantic tokens, not only raw colours or pixel measurements. Products may introduce additional private tokens, but should map the shared set below.

```ts
type UbeeqSemanticTokens = {
  "color.canvas": string;
  "color.surface": string;
  "color.surface-raised": string;
  "color.text": string;
  "color.text-muted": string;
  "color.border": string;
  "color.action": string;
  "color.action-hover": string;
  "color.focus": string;
  "color.success": string;
  "color.warning": string;
  "color.danger": string;
  "font.body": string;
  "font.display": string;
  "space.1": string;
  "space.2": string;
  "space.3": string;
  "space.4": string;
  "radius.control": string;
  "radius.surface": string;
  "shadow.raised": string;
  "motion.fast": string;
  "motion.standard": string;
};
```

Every visual state needs a readable light/dark or contrast treatment as relevant to the product. Focus rings, disabled controls, destructive actions, error text, and non-colour state indicators are mandatory.

## 4. Shared mockup requirements

For every proposed screen, provide:

1. Desktop frame and one narrow/mobile frame.
2. Page purpose, primary user, and primary action.
3. Default, empty, loading, error, permission-denied, and success states where applicable.
4. Keyboard focus order and interaction notes for dialogs, menus, uploads, and drag/drop.
5. Reusable components labelled as either `@ubeeq/ui` primitive, product component, or page-specific composition.
6. Content rules: realistic sample text, truncation behavior, dates, count ranges, and image aspect ratios.
7. Asset source: final asset, licensed placeholder, or explicitly temporary design asset.
8. Responsive behavior: what collapses, scrolls, becomes a drawer, or is omitted on a narrow screen.

Do not use a static design to hide consequential application states. Uploading, queued/processing/failed assets, moderation holds, unavailable integrations, no-results views, and destructive confirmations must be designed deliberately.

## 5. Ubeeq reference UI mockups

Ubeeq should feel capable, calm, and intentionally unbranded. Its UI demonstrates a portable reference instance; it must not resemble a disguised hosted product.

### 5.1 Required screens

- Reference landing/install page: what Ubeeq is, local/self-host start, documentation and extension guide entry points.
- Local sign-in and first-run setup.
- Creator workspace shell: navigation, account switch/context, status and diagnostics entry points.
- Work list and Work detail: draft, processing, published, failed, and held work.
- Asset upload: upload initiation, progress, checksum/validation failure, processing queue, rendition state, retry.
- Collection editor and public Work view.
- Export and import: manifest download, dry-run result, conflicts, checkpoints, secret exclusion explanation.
- Neutral operations/reviewer shell: jobs, recovery, holds, review cases, audit, regional diagnostics.

### 5.2 Ubeeq-specific constraints

- No pricing, discovery ranking, product eligibility, creator-marketplace language, or hosted-brand references.
- Use plain Ubeeq terminology: Creator, Work, Asset, Collection, Publication, Integration Account, Review Case.
- Make deployment and data-home context visible where useful, without presenting cloud-provider implementation details as requirements.

## 6. Eversally mockups

Eversally is a private creator product. Its existing product surface includes creator/public pages, Studio, discovery, challenges, collections, profile configuration, billing, and administration. The mockups should improve and unify that surface rather than merely re-skin it.

### 6.1 Priority screen set

- Marketing landing and authenticated home.
- Public Creator and Space profile.
- Public Work/gallery and focused viewer.
- Eversally Studio dashboard, Work editor, asset manager, and publication controls.
- Profile appearance and Space configuration.
- Discovery feed, search/filter controls, and focused viewer.
- Collections and challenges.
- Account, billing, integrations, and export settings.
- Operator/admin surfaces only after creator/public flows are settled.

### 6.2 Eversally design decisions needed in mockups

- Which current visual identity elements remain: the orb/wordmark, “Creativity. Everywhere.”, creator/Space terminology, and current discovery density.
- How a Studio workflow differs visually from the public viewing experience.
- The intended level of editorial richness versus productivity density.
- How challenge, discovery, and collection signals are represented without conflating them with neutral Ubeeq publication state.

## 7. Nightframe mockups

Nightframe is a private, independent product composition. Its landing direction establishes a dark, considered, intimate visual language, but it does not yet have a product workspace or operations UI.

### 7.1 Priority screen set

- Marketing landing and eligibility/membership entry flow.
- Authenticated home and creator workspace shell.
- Work creation, upload, processing, and publication flow.
- Public Creator and Work presentation.
- Access/consent state presentation: unavailable, pending, held, allowed, and restricted delivery.
- Profile/appearance settings, integrations, export, and account settings.
- Reviewer/operator UI after the creator workflow is established.

### 7.2 Nightframe design decisions needed in mockups

- The meaning and use of the dark palette, violet/pink accents, and crescent mark.
- How consent and access notices should feel: clear and calm rather than punitive or generic.
- Public versus authenticated visual density and navigation.
- Whether the product uses an editorial canvas, gallery grid, immersive viewer, or mixed layout as its dominant work presentation.

## 8. Component extension model

The following sequence should guide implementation.

1. Add a neutral primitive only when at least two Ubeeq flows or product implementations need the same behavior.
2. Define its semantic token inputs and accessibility behavior in `@ubeeq/ui`.
3. Implement product appearance through private token maps and component wrappers.
4. Keep product-specific composites private—for example, an Eversally discovery card or a Nightframe consent gate.
5. Test primitives for keyboard, focus, labels, invalid states, reduced motion, and responsive behavior. Test product compositions for their own product rules.

Example:

```tsx
// Public: behavior and semantic slots only.
<UbeeqUploadPanel
  state={uploadState}
  onSelect={selectFile}
  onRetry={retryUpload}
/>

// Private: Eversally visual composition and copy.
<EversallyStudioUploadPanel work={work} />

// Private: Nightframe access and visual composition.
<NightframeWorkUploadPanel work={work} admission={admission} />
```

## 9. Mockup handoff package

Each product handoff should contain:

- A Figma file or equivalent source with named pages and components.
- An exported annotated PDF or image board for quick review.
- Token sheet with semantic mappings and type scale.
- Asset folder containing approved marks, icons, illustrations, photography, and licenses/source notes.
- Screen inventory ordered by implementation priority.
- Interaction notes for every non-obvious behavior.
- Copy document for product-specific strings and legal/policy-reviewed text.
- A decision log marking items as final, provisional, or intentionally deferred.

The minimum first implementation bundle for each product is: application shell, one primary list view, one detail/editor view, one upload state flow, one public view, and the full set of empty/loading/error/permission states for those flows.

## 10. Review gates

Before implementation begins, confirm:

- The screen’s ownership is Ubeeq, Eversally, or Nightframe.
- Any product policy expressed by the screen is supplied by the private product extension, not a public Ubeeq default.
- Component boundaries are identified: neutral primitive, private product component, or page composition.
- Responsive and accessibility states are present.
- Assets and copy are approved for the intended repository visibility.

Before merge, verify:

- No Eversally or Nightframe name, asset, copy, token value, or conditional enters public Ubeeq except in explicitly approved external documentation.
- A product UI can upgrade `@ubeeq/ui` without importing another product’s package.
- Component tests cover keyboard/focus behavior and state variants.
- Visual regression review covers desktop and narrow layouts.

## 11. Recommended implementation order

1. Establish Ubeeq semantic tokens and accessible primitives from the shared mockup requirements.
2. Build the Ubeeq reference workspace shell and creator-to-public Work flow.
3. Extract Eversally’s reusable product shell/tokens from the existing application, then implement its highest-value mockups.
4. Create Nightframe’s private UI package and application shell from its approved mockups; do not fork Eversally’s UI.
5. Add operations/admin surfaces only once the corresponding creator/public flows have settled.

