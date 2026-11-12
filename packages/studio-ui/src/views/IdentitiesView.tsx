import React, { useState } from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";

export interface CreatorIdentityItem {
  id: string;
  handle: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string;
  createdAt: string;
}

export interface IdentitiesViewProps {
  identities: CreatorIdentityItem[];
  activeIdentityId?: string;
  onSwitchIdentity?: (identityId: string) => void;
  onCreateIdentity?: (input: { handle: string; displayName: string; bio?: string }) => Promise<void> | void;
  onUpdateIdentity?: (identityId: string, updates: { displayName: string; bio?: string }) => Promise<void> | void;
  loading?: boolean;
}

export const IdentitiesView: React.FC<IdentitiesViewProps> = ({
  identities,
  activeIdentityId,
  onSwitchIdentity,
  onCreateIdentity,
  onUpdateIdentity,
  loading = false,
}) => {
  const brand = useStudioBrand();
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const activeIdentity = identities.find((i) => i.id === activeIdentityId) ?? identities[0];

  const [editDisplayName, setEditDisplayName] = useState(activeIdentity?.displayName ?? "");
  const [editBio, setEditBio] = useState(activeIdentity?.bio ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!handle.trim() || !displayName.trim() || !onCreateIdentity) return;
    setIsCreating(true);
    setCreateError(undefined);

    try {
      await onCreateIdentity({
        handle: handle.trim().toLowerCase(),
        displayName: displayName.trim(),
        bio: bio.trim() || undefined,
      });
      setHandle("");
      setDisplayName("");
      setBio("");
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create identity.");
    } finally {
      setIsCreating(false);
    }
  };

  const handleSaveActive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeIdentity || !onUpdateIdentity) return;
    setIsSaving(true);
    setSaveSuccess(false);

    try {
      await onUpdateIdentity(activeIdentity.id, {
        displayName: editDisplayName.trim(),
        bio: editBio.trim() || undefined,
      });
      setSaveSuccess(true);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="ubeeq-studio-identities-view">
      <header className="ubeeq-studio-view-header">
        <div>
          <h1>Creator Identities</h1>
          <p>
            As the single operator of {brand.studioName}, you can operate and switch
            between multiple distinct public creator identities and personas.
          </p>
        </div>
      </header>

      <div className="ubeeq-identities-layout">
        <section className="ubeeq-identities-list-section">
          <h2>Your Personas ({identities.length})</h2>
          {loading ? (
            <p className="ubeeq-loading">Loading identities…</p>
          ) : (
            <ul className="ubeeq-identities-cards">
              {identities.map((item) => {
                const isActive = item.id === (activeIdentityId || activeIdentity?.id);
                return (
                  <li
                    key={item.id}
                    className={`ubeeq-identity-card ${
                      isActive ? "ubeeq-identity-active" : ""
                    }`}
                  >
                    <div>
                      <h3>{item.displayName}</h3>
                      <span className="ubeeq-handle">@{item.handle}</span>
                      {isActive && <span className="ubeeq-badge-active">Active</span>}
                    </div>
                    {!isActive && onSwitchIdentity && (
                      <button
                        type="button"
                        onClick={() => onSwitchIdentity(item.id)}
                        className="ubeeq-btn-secondary-sm"
                      >
                        Switch To
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {onCreateIdentity && (
            <form onSubmit={handleCreate} className="ubeeq-identity-create-card">
              <h3>Create New Persona</h3>
              <div className="ubeeq-form-field">
                <label htmlFor="new-handle">Handle</label>
                <input
                  id="new-handle"
                  type="text"
                  placeholder="persona-handle"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  disabled={isCreating}
                  required
                />
              </div>

              <div className="ubeeq-form-field">
                <label htmlFor="new-name">Display Name</label>
                <input
                  id="new-name"
                  type="text"
                  placeholder="Display Name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  disabled={isCreating}
                  required
                />
              </div>

              <div className="ubeeq-form-field">
                <label htmlFor="new-bio">Short Bio</label>
                <textarea
                  id="new-bio"
                  rows={2}
                  placeholder="Artist, Photographer, Writer…"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  disabled={isCreating}
                />
              </div>

              {createError && (
                <p className="ubeeq-form-error" role="alert">
                  {createError}
                </p>
              )}

              <button
                type="submit"
                disabled={!handle.trim() || !displayName.trim() || isCreating}
                className="ubeeq-btn-primary"
              >
                {isCreating ? "Creating…" : "Add Persona"}
              </button>
            </form>
          )}
        </section>

        {activeIdentity && (
          <section className="ubeeq-identity-edit-section">
            <h2>Active Persona Profile</h2>
            <form onSubmit={handleSaveActive} className="ubeeq-identity-edit-form">
              <div className="ubeeq-form-field">
                <label>Handle</label>
                <input type="text" value={`@${activeIdentity.handle}`} disabled readOnly />
              </div>

              <div className="ubeeq-form-field">
                <label htmlFor="edit-name">Display Name</label>
                <input
                  id="edit-name"
                  type="text"
                  value={editDisplayName}
                  onChange={(e) => setEditDisplayName(e.target.value)}
                  disabled={isSaving}
                  required
                />
              </div>

              <div className="ubeeq-form-field">
                <label htmlFor="edit-bio">Bio</label>
                <textarea
                  id="edit-bio"
                  rows={4}
                  value={editBio}
                  onChange={(e) => setEditBio(e.target.value)}
                  disabled={isSaving}
                />
              </div>

              {saveSuccess && (
                <p className="ubeeq-form-success">Persona profile updated.</p>
              )}

              <button
                type="submit"
                disabled={isSaving}
                className="ubeeq-btn-primary"
              >
                {isSaving ? "Saving…" : "Save Profile"}
              </button>
            </form>
          </section>
        )}
      </div>
    </div>
  );
};
