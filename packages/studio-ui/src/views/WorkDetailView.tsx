import React, { useState } from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";
import { ExtensionSlot } from "../context/StudioExtensionSlots.js";
import { ActionConfirmationDialog } from "../components/ActionConfirmationDialog.js";

export interface WorkAssetItem {
  id: string;
  role: string;
  mimeType: string;
  sizeBytes?: number;
  previewUrl?: string;
  caption?: string;
}

export interface WorkDetailData {
  id: string;
  creatorId: string;
  title: string;
  slug: string;
  description?: string;
  status: string;
  kind: string;
  tags: string[];
  assets: WorkAssetItem[];
}

export interface WorkDetailViewProps {
  work: WorkDetailData;
  onSave?: (updates: Partial<WorkDetailData>) => Promise<void> | void;
  onRemoveAsset?: (assetId: string) => Promise<void> | void;
  onNavigatePublish?: (workId: string) => void;
  onBack?: () => void;
}

export const WorkDetailView: React.FC<WorkDetailViewProps> = ({
  work,
  onSave,
  onRemoveAsset,
  onNavigatePublish,
  onBack,
}) => {
  const brand = useStudioBrand();
  const [title, setTitle] = useState(work.title);
  const [description, setDescription] = useState(work.description ?? "");
  const [tags, setTags] = useState(work.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();

  // Asset deletion modal state
  const [assetToRemove, setAssetToRemove] = useState<WorkAssetItem | null>(null);
  const [busyRemoveAsset, setBusyRemoveAsset] = useState(false);
  const [removeAssetError, setRemoveAssetError] = useState<string | undefined>();

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSave) return;
    setSaving(true);
    setSaveSuccess(false);
    setSaveError(undefined);
    try {
      await onSave({
        title,
        description,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save work.");
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmRemoveAsset = async () => {
    if (!assetToRemove || !onRemoveAsset) return;
    setBusyRemoveAsset(true);
    setRemoveAssetError(undefined);
    try {
      await onRemoveAsset(assetToRemove.id);
      setAssetToRemove(null);
    } catch (err) {
      setRemoveAssetError(
        err instanceof Error ? err.message : "Failed to remove asset.",
      );
    } finally {
      setBusyRemoveAsset(false);
    }
  };

  return (
    <div className="ubeeq-studio-work-detail-view">
      <header className="ubeeq-studio-view-header">
        <div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="ubeeq-btn-link ubeeq-back-btn"
            >
              ← Back to Works
            </button>
          )}
          <h1>{title}</h1>
          <p className="ubeeq-studio-subtext">
            Editing work in {brand.studioName}. Slug: <code>/{work.slug}</code>
          </p>
        </div>
        <div className="ubeeq-detail-header-actions">
          {onNavigatePublish && (
            <button
              type="button"
              onClick={() => onNavigatePublish(work.id)}
              className="ubeeq-btn-primary"
            >
              Publishing Options
            </button>
          )}
          {/* Extension Slot: workDetailActionsSlot */}
          <ExtensionSlot
            name="workDetailActionsSlot"
            props={{ workId: work.id, creatorId: work.creatorId }}
          />
        </div>
      </header>

      <div className="ubeeq-detail-layout">
        <form onSubmit={handleSave} className="ubeeq-detail-main-form">
          <div className="ubeeq-form-field">
            <label htmlFor="work-title">Title</label>
            <input
              id="work-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div className="ubeeq-form-field">
            <label htmlFor="work-desc">Description</label>
            <textarea
              id="work-desc"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="ubeeq-form-field">
            <label htmlFor="work-tags">Tags (comma separated)</label>
            <input
              id="work-tags"
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>

          {saveError && (
            <p className="ubeeq-form-error" role="alert">
              {saveError}
            </p>
          )}
          {saveSuccess && (
            <p className="ubeeq-form-success">Work updated successfully.</p>
          )}

          <div className="ubeeq-form-actions">
            <button
              type="submit"
              disabled={saving}
              className="ubeeq-btn-primary"
            >
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>

        <section className="ubeeq-detail-assets-section">
          <h2>Assets ({work.assets.length})</h2>
          {work.assets.length === 0 ? (
            <p className="ubeeq-empty-note">
              No assets attached to this work yet.
            </p>
          ) : (
            <div className="ubeeq-assets-grid">
              {work.assets.map((asset) => (
                <div key={asset.id} className="ubeeq-asset-card">
                  {asset.previewUrl ? (
                    <img
                      src={asset.previewUrl}
                      alt={asset.caption || "Work asset"}
                      className="ubeeq-asset-img"
                    />
                  ) : (
                    <div className="ubeeq-asset-placeholder">
                      {asset.mimeType}
                    </div>
                  )}
                  <div className="ubeeq-asset-info">
                    <span className="ubeeq-asset-role">{asset.role}</span>
                    {asset.sizeBytes && (
                      <span className="ubeeq-asset-size">
                        {Math.round(asset.sizeBytes / 1024)} KB
                      </span>
                    )}
                  </div>

                  <div className="ubeeq-asset-card-actions">
                    {/* Extension Slot: assetToolbarSlot */}
                    <ExtensionSlot
                      name="assetToolbarSlot"
                      props={{ assetId: asset.id, workId: work.id }}
                    />
                    {onRemoveAsset && (
                      <button
                        type="button"
                        onClick={() => setAssetToRemove(asset)}
                        className="ubeeq-btn-danger-sm"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Accessible Confirmation Modal for Removing Asset */}
      <ActionConfirmationDialog
        isOpen={assetToRemove !== null}
        title="Remove Asset"
        resourceName={assetToRemove?.id}
        description={
          <p>
            Are you sure you want to detach this asset from{" "}
            <strong>{title}</strong>? The media file will no longer be delivered
            with this work in {brand.studioName}.
          </p>
        }
        irreversible={true}
        confirmLabel="Remove Asset"
        cancelLabel="Keep Asset"
        confirmTone="danger"
        busy={busyRemoveAsset}
        error={removeAssetError}
        onCancel={() => {
          if (!busyRemoveAsset) {
            setAssetToRemove(null);
            setRemoveAssetError(undefined);
          }
        }}
        onConfirm={handleConfirmRemoveAsset}
      />
    </div>
  );
};
