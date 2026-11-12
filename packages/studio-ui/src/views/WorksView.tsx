import React, { useState, useMemo } from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";
import { ActionConfirmationDialog } from "../components/ActionConfirmationDialog.js";

export interface WorkSummaryItem {
  id: string;
  title: string;
  slug: string;
  status: "draft" | "ready" | "archived" | "deleted" | string;
  kind?: string;
  createdAt: string;
  updatedAt: string;
  assetCount?: number;
}

export interface WorksViewProps {
  works: WorkSummaryItem[];
  onCreateWork?: (title: string, kind?: string) => Promise<void> | void;
  onSelectWork?: (workId: string) => void;
  onDeleteWork?: (workId: string) => Promise<void> | void;
  loading?: boolean;
}

export const WorksView: React.FC<WorksViewProps> = ({
  works,
  onCreateWork,
  onSelectWork,
  onDeleteWork,
  loading = false,
}) => {
  const brand = useStudioBrand();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [newTitle, setNewTitle] = useState("");
  const [newKind, setNewKind] = useState("image");
  const [isCreating, setIsCreating] = useState(false);
  const [workToDelete, setWorkToDelete] = useState<WorkSummaryItem | null>(null);
  const [busyDelete, setBusyDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>();

  const filteredWorks = useMemo(() => {
    return works.filter((w) => {
      const matchesSearch =
        !search ||
        w.title.toLowerCase().includes(search.toLowerCase()) ||
        w.slug.toLowerCase().includes(search.toLowerCase());
      const matchesStatus =
        statusFilter === "all" || w.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [works, search, statusFilter]);

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !onCreateWork) return;
    setIsCreating(true);
    try {
      await onCreateWork(newTitle.trim(), newKind);
      setNewTitle("");
    } finally {
      setIsCreating(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!workToDelete || !onDeleteWork) return;
    setBusyDelete(true);
    setDeleteError(undefined);
    try {
      await onDeleteWork(workToDelete.id);
      setWorkToDelete(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Failed to delete work.",
      );
    } finally {
      setBusyDelete(false);
    }
  };

  return (
    <div className="ubeeq-studio-works-view">
      <header className="ubeeq-studio-view-header">
        <div>
          <h1>Works</h1>
          <p>
            Create and organize creative works in {brand.studioName}.
          </p>
        </div>
        {onCreateWork && (
          <form
            onSubmit={handleCreateSubmit}
            className="ubeeq-studio-create-form"
          >
            <input
              type="text"
              placeholder="New work title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              disabled={isCreating}
            />
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              disabled={isCreating}
            >
              <option value="image">Image / Gallery</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="article">Article</option>
            </select>
            <button
              type="submit"
              disabled={!newTitle.trim() || isCreating}
              className="ubeeq-btn-primary"
            >
              {isCreating ? "Creating…" : "New Work"}
            </button>
          </form>
        )}
      </header>

      <div className="ubeeq-studio-toolbar">
        <input
          type="search"
          placeholder="Search works…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ubeeq-search-input"
        />
        <div className="ubeeq-filter-group">
          <label>Status:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="ready">Ready</option>
            <option value="archived">Archived</option>
          </select>
        </div>
      </div>

      {loading ? (
        <p className="ubeeq-loading">Loading works…</p>
      ) : filteredWorks.length === 0 ? (
        <div className="ubeeq-empty-state">
          <p>No works found.</p>
        </div>
      ) : (
        <ul className="ubeeq-works-list">
          {filteredWorks.map((work) => (
            <li key={work.id} className="ubeeq-work-card">
              <div
                className="ubeeq-work-info"
                onClick={() => onSelectWork?.(work.id)}
                role="button"
                tabIndex={0}
              >
                <h3>{work.title}</h3>
                <span className="ubeeq-work-slug">/{work.slug}</span>
                <span className={`ubeeq-status-badge ubeeq-status-${work.status}`}>
                  {work.status}
                </span>
              </div>
              <div className="ubeeq-work-actions">
                <button
                  type="button"
                  onClick={() => onSelectWork?.(work.id)}
                  className="ubeeq-btn-secondary"
                >
                  Edit
                </button>
                {onDeleteWork && (
                  <button
                    type="button"
                    onClick={() => setWorkToDelete(work)}
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

      {/* Accessible Confirmation Modal replacing any window.confirm */}
      <ActionConfirmationDialog
        isOpen={workToDelete !== null}
        title="Delete Work"
        resourceName={workToDelete?.title}
        description={
          <p>
            Deleting this work will remove its metadata and associations from{" "}
            {brand.studioName}.
          </p>
        }
        irreversible={true}
        confirmLabel="Delete Work"
        cancelLabel="Keep Work"
        confirmTone="danger"
        busy={busyDelete}
        error={deleteError}
        onCancel={() => {
          if (!busyDelete) {
            setWorkToDelete(null);
            setDeleteError(undefined);
          }
        }}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
};
