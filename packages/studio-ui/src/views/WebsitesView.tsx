import React, { useState } from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";
import { ActionConfirmationDialog } from "../components/ActionConfirmationDialog.js";

export interface WebsiteItem {
  id: string;
  title: string;
  locale: string;
  homePageId: string;
  pageCount?: number;
  customDomain?: string;
  updatedAt: string;
}

export interface WebsitesViewProps {
  websites: WebsiteItem[];
  onCreateWebsite?: (title: string) => Promise<void> | void;
  onExportStaticZip?: (websiteId: string) => Promise<void> | void;
  onDeleteWebsite?: (websiteId: string) => Promise<void> | void;
  onSelectWebsite?: (websiteId: string) => void;
  loading?: boolean;
}

export const WebsitesView: React.FC<WebsitesViewProps> = ({
  websites,
  onCreateWebsite,
  onExportStaticZip,
  onDeleteWebsite,
  onSelectWebsite,
  loading = false,
}) => {
  const brand = useStudioBrand();
  const [newTitle, setNewTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const [toDelete, setToDelete] = useState<WebsiteItem | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !onCreateWebsite) return;
    setIsCreating(true);
    try {
      await onCreateWebsite(newTitle.trim());
      setNewTitle("");
    } finally {
      setIsCreating(false);
    }
  };

  const handleExport = async (siteId: string) => {
    if (!onExportStaticZip) return;
    setExportingId(siteId);
    try {
      await onExportStaticZip(siteId);
    } finally {
      setExportingId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!toDelete || !onDeleteWebsite) return;
    setBusyDelete(true);
    setDeleteError(undefined);
    try {
      await onDeleteWebsite(toDelete.id);
      setToDelete(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete website.",
      );
    } finally {
      setBusyDelete(false);
    }
  };

  return (
    <div className="ubeeq-studio-websites-view">
      <header className="ubeeq-studio-view-header">
        <div>
          <h1>Websites</h1>
          <p>
            Build and export static personal websites in {brand.studioName}.
          </p>
        </div>

        {onCreateWebsite && (
          <form onSubmit={handleCreate} className="ubeeq-studio-create-form">
            <input
              type="text"
              placeholder="Website title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              disabled={isCreating}
            />
            <button
              type="submit"
              disabled={!newTitle.trim() || isCreating}
              className="ubeeq-btn-primary"
            >
              {isCreating ? "Creating…" : "New Website"}
            </button>
          </form>
        )}
      </header>

      {loading ? (
        <p className="ubeeq-loading">Loading websites…</p>
      ) : websites.length === 0 ? (
        <div className="ubeeq-empty-state">
          <p>No websites configured. Create a personal website to showcase your portfolio.</p>
        </div>
      ) : (
        <ul className="ubeeq-websites-list">
          {websites.map((site) => (
            <li key={site.id} className="ubeeq-website-card">
              <div
                className="ubeeq-website-info"
                onClick={() => onSelectWebsite?.(site.id)}
                role="button"
                tabIndex={0}
              >
                <h3>{site.title}</h3>
                <span className="ubeeq-website-meta">
                  {site.customDomain ? `Domain: ${site.customDomain}` : "No custom domain"} | Locale: {site.locale}
                </span>
              </div>
              <div className="ubeeq-website-actions">
                <button
                  type="button"
                  onClick={() => onSelectWebsite?.(site.id)}
                  className="ubeeq-btn-secondary"
                >
                  Edit Pages
                </button>
                {onExportStaticZip && (
                  <button
                    type="button"
                    onClick={() => handleExport(site.id)}
                    disabled={exportingId === site.id}
                    className="ubeeq-btn-secondary"
                  >
                    {exportingId === site.id ? "Exporting…" : "Export Static ZIP"}
                  </button>
                )}
                {onDeleteWebsite && (
                  <button
                    type="button"
                    onClick={() => setToDelete(site)}
                    className="ubeeq-btn-danger"
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Accessible Confirmation Modal for Website Deletion */}
      <ActionConfirmationDialog
        isOpen={toDelete !== null}
        title="Delete Website"
        resourceName={toDelete?.title}
        description={
          <p>
            Deleting this website will remove all authored pages and navigation
            structures from {brand.studioName}.
          </p>
        }
        irreversible={true}
        confirmLabel="Delete Website"
        cancelLabel="Keep Website"
        confirmTone="danger"
        busy={busyDelete}
        error={deleteError}
        onCancel={() => {
          if (!busyDelete) {
            setToDelete(null);
            setDeleteError(undefined);
          }
        }}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
};
