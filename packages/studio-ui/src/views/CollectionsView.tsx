import React, { useState } from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";
import { ActionConfirmationDialog } from "../components/ActionConfirmationDialog.js";

export interface CollectionSummaryItem {
  id: string;
  title: string;
  slug: string;
  type: string;
  status: string;
  visibility: string;
  workCount?: number;
  updatedAt: string;
}

export interface CollectionsViewProps {
  collections: CollectionSummaryItem[];
  onCreateCollection?: (input: { title: string; type: string }) => Promise<void> | void;
  onSelectCollection?: (collectionId: string) => void;
  onDeleteCollection?: (collectionId: string) => Promise<void> | void;
  loading?: boolean;
}

export const CollectionsView: React.FC<CollectionsViewProps> = ({
  collections,
  onCreateCollection,
  onSelectCollection,
  onDeleteCollection,
  loading = false,
}) => {
  const brand = useStudioBrand();
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState("gallery");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const [toDelete, setToDelete] = useState<CollectionSummaryItem | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !onCreateCollection) return;
    setIsCreating(true);
    setCreateError(undefined);
    try {
      await onCreateCollection({ title: newTitle.trim(), type: newType });
      setNewTitle("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create collection.");
    } finally {
      setIsCreating(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!toDelete || !onDeleteCollection) return;
    setBusyDelete(true);
    setDeleteError(undefined);
    try {
      await onDeleteCollection(toDelete.id);
      setToDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete collection.");
    } finally {
      setBusyDelete(false);
    }
  };

  return (
    <div className="ubeeq-studio-collections-view">
      <header className="ubeeq-studio-view-header">
        <div>
          <h1>Collections</h1>
          <p>
            Curate and group works into galleries and series in {brand.studioName}.
          </p>
        </div>

        {onCreateCollection && (
          <form onSubmit={handleCreate} className="ubeeq-studio-create-form">
            <input
              type="text"
              placeholder="Collection title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              disabled={isCreating}
            />
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              disabled={isCreating}
            >
              <option value="gallery">Gallery</option>
              <option value="series">Series</option>
              <option value="collection">Collection</option>
            </select>
            <button
              type="submit"
              disabled={!newTitle.trim() || isCreating}
              className="ubeeq-btn-primary"
            >
              {isCreating ? "Creating…" : "New Collection"}
            </button>
          </form>
        )}
      </header>

      {createError && (
        <p className="ubeeq-form-error" role="alert">
          {createError}
        </p>
      )}

      {loading ? (
        <p className="ubeeq-loading">Loading collections…</p>
      ) : collections.length === 0 ? (
        <div className="ubeeq-empty-state">
          <p>No collections found. Create a collection to organize your works.</p>
        </div>
      ) : (
        <ul className="ubeeq-collections-list">
          {collections.map((col) => (
            <li key={col.id} className="ubeeq-collection-card">
              <div
                className="ubeeq-collection-info"
                onClick={() => onSelectCollection?.(col.id)}
                role="button"
                tabIndex={0}
              >
                <h3>{col.title}</h3>
                <span className="ubeeq-collection-meta">
                  Type: {col.type} | Slug: /{col.slug}
                </span>
                <span className={`ubeeq-status-badge ubeeq-status-${col.status}`}>
                  {col.status}
                </span>
              </div>
              <div className="ubeeq-collection-actions">
                <button
                  type="button"
                  onClick={() => onSelectCollection?.(col.id)}
                  className="ubeeq-btn-secondary"
                >
                  Manage
                </button>
                {onDeleteCollection && (
                  <button
                    type="button"
                    onClick={() => setToDelete(col)}
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

      {/* Accessible Confirmation Modal */}
      <ActionConfirmationDialog
        isOpen={toDelete !== null}
        title="Delete Collection"
        resourceName={toDelete?.title}
        description={
          <p>
            Deleting this collection will disband the group in {brand.studioName}.
            Individual member works will not be deleted.
          </p>
        }
        irreversible={true}
        confirmLabel="Delete Collection"
        cancelLabel="Keep Collection"
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
