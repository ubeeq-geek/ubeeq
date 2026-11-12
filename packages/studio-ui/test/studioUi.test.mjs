import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  defaultStudioBrand,
  StudioBrandProvider,
  useStudioBrand,
  StudioExtensionSlotsProvider,
  ExtensionSlot,
  ActionConfirmationDialog,
  WorksView,
  WorkDetailView,
  WorkPublishView,
  CollectionsView,
  AnnouncementsView,
  WebsitesView,
  ConnectorsView,
  IdentitiesView,
  SettingsView,
} from "../dist/index.js";

test("StudioBrandContext defaults to Ubeeq Studio and accepts custom brand", () => {
  assert.equal(defaultStudioBrand.studioName, "Ubeeq Studio");

  function TestBrandConsumer() {
    const brand = useStudioBrand();
    return React.createElement("div", { id: "brand-name" }, brand.studioName);
  }

  // Default provider
  const defaultHtml = renderToStaticMarkup(
    React.createElement(
      StudioBrandProvider,
      null,
      React.createElement(TestBrandConsumer),
    ),
  );
  assert.ok(defaultHtml.includes("Ubeeq Studio"));

  // Custom provider
  const customHtml = renderToStaticMarkup(
    React.createElement(
      StudioBrandProvider,
      { brand: { studioName: "Custom Self-Hosted Studio" } },
      React.createElement(TestBrandConsumer),
    ),
  );
  assert.ok(customHtml.includes("Custom Self-Hosted Studio"));
});

test("StudioExtensionSlots renders injected components or returns null when slot is empty", () => {
  // Empty slots
  const emptyHtml = renderToStaticMarkup(
    React.createElement(
      StudioExtensionSlotsProvider,
      { slots: {} },
      React.createElement(ExtensionSlot, {
        name: "workDetailActionsSlot",
        props: { workId: "w1", creatorId: "c1" },
      }),
    ),
  );
  assert.equal(emptyHtml, "");

  // Injected slot
  const MockCustomBanner = ({ workId }) =>
    React.createElement("div", { className: "mock-banner" }, `Work: ${workId}`);

  const injectedHtml = renderToStaticMarkup(
    React.createElement(
      StudioExtensionSlotsProvider,
      {
        slots: {
          workDetailActionsSlot: MockCustomBanner,
        },
      },
      React.createElement(ExtensionSlot, {
        name: "workDetailActionsSlot",
        props: { workId: "test-work-123", creatorId: "c1" },
      }),
    ),
  );
  assert.ok(injectedHtml.includes("mock-banner"));
  assert.ok(injectedHtml.includes("Work: test-work-123"));
});

test("ActionConfirmationDialog renders accessible <dialog> with initial Cancel button and error banner", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActionConfirmationDialog, {
      isOpen: true,
      title: "Remove Test Resource",
      resourceName: "Test Item #1",
      description: "Are you sure you want to proceed?",
      irreversible: true,
      confirmLabel: "Delete Forever",
      cancelLabel: "Cancel",
      busy: false,
      error: "Network timeout. Please retry.",
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );

  assert.ok(html.includes("<dialog"));
  assert.ok(html.includes('role="alert"'));
  assert.ok(html.includes("Network timeout. Please retry."));
  assert.ok(html.includes("This action cannot be undone."));
  assert.ok(html.includes("Remove Test Resource"));
  assert.ok(html.includes("Cancel"));
  assert.ok(html.includes("Delete Forever"));
});

test("Core studio views render static markup cleanly with brand context", () => {
  const brandWrap = (child) =>
    React.createElement(
      StudioBrandProvider,
      { brand: { studioName: "Testing Studio" } },
      child,
    );

  // WorksView
  const worksHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(WorksView, {
        works: [
          {
            id: "w1",
            title: "First Work",
            slug: "first-work",
            status: "ready",
            createdAt: "2026-01-01",
            updatedAt: "2026-01-02",
          },
        ],
      }),
    ),
  );
  assert.ok(worksHtml.includes("First Work"));
  assert.ok(worksHtml.includes("Testing Studio"));

  // WorkDetailView
  const detailHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(WorkDetailView, {
        work: {
          id: "w1",
          creatorId: "c1",
          title: "First Work",
          slug: "first-work",
          status: "ready",
          kind: "image",
          tags: ["art", "nature"],
          assets: [
            { id: "a1", role: "primary", mimeType: "image/jpeg", sizeBytes: 1024 },
          ],
        },
      }),
    ),
  );
  assert.ok(detailHtml.includes("Assets (1)"));

  // WorkPublishView
  const pubHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(WorkPublishView, {
        workId: "w1",
        workTitle: "First Work",
        publications: [],
      }),
    ),
  );
  assert.ok(pubHtml.includes("Publishing: First Work"));

  // CollectionsView
  const collectionsHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(CollectionsView, {
        collections: [
          {
            id: "col1",
            title: "Series 1",
            slug: "series-1",
            type: "series",
            status: "published",
            visibility: "public",
            updatedAt: "2026-01-01",
          },
        ],
      }),
    ),
  );
  assert.ok(collectionsHtml.includes("Series 1"));

  // AnnouncementsView
  const annHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(AnnouncementsView, {
        announcements: [],
      }),
    ),
  );
  assert.ok(annHtml.includes("Announcements"));

  // WebsitesView
  const webHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(WebsitesView, {
        websites: [],
      }),
    ),
  );
  assert.ok(webHtml.includes("Websites"));

  // ConnectorsView
  const connHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(ConnectorsView, {
        connectors: [],
      }),
    ),
  );
  assert.ok(connHtml.includes("External Connectors"));
  assert.ok(connHtml.includes("YouTube"));
  assert.ok(connHtml.includes("Bluesky"));

  // IdentitiesView
  const idHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(IdentitiesView, {
        identities: [
          {
            id: "c1",
            handle: "main-artist",
            displayName: "Main Artist",
            createdAt: "2026-01-01",
          },
        ],
      }),
    ),
  );
  assert.ok(idHtml.includes("Main Artist"));
  assert.ok(idHtml.includes("@main-artist"));

  // SettingsView
  const settingsHtml = renderToStaticMarkup(
    brandWrap(
      React.createElement(SettingsView, {
        creatorId: "c1",
        operatorEmail: "operator@example.test",
      }),
    ),
  );
  assert.ok(settingsHtml.includes("operator@example.test"));
  assert.ok(settingsHtml.includes("Testing Studio"));
});
