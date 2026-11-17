import React, { useState } from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";
import { ExtensionSlot } from "../context/StudioExtensionSlots.js";
import { ActionConfirmationDialog } from "../components/ActionConfirmationDialog.js";

export interface ExistingPublicationItem {
  id: string;
  destination: string;
  status: "draft" | "live" | "removed" | string;
  visibility: "public" | "unlisted" | "private" | string;
  publishedAt?: string;
}

export interface WorkPublishViewProps {
  workId: string;
  workTitle: string;
  publications: ExistingPublicationItem[];
  onPublishNative?: (options: {
    published: boolean;
    visibility: string;
    announcement?: { mode: string; message?: string };
  }) => Promise<void> | void;
  onBack?: () => void;
}

export const WorkPublishView: React.FC<WorkPublishViewProps> = ({
  workId,
  workTitle,
  publications,
  onPublishNative,
  onBack,
}) => {
  const brand = useStudioBrand();
  const [visibility, setVisibility] = useState<string>("public");
  const [enableAnnouncement, setEnableAnnouncement] = useState(false);
  const [announcementMsg, setAnnouncementMsg] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishStatus, setPublishStatus] = useState<string | undefined>();
  const [publishError, setPublishError] = useState<string | undefined>();

  // Unpublish modal state
  const [showUnpublishModal, setShowUnpublishModal] = useState(false);
  const [busyUnpublish, setBusyUnpublish] = useState(false);
  const [unpublishError, setUnpublishError] = useState<string | undefined>();

  const nativePub = publications.find(
    (p) => p.destination === "native" && p.status === "live",
  );
  const isPublished = Boolean(nativePub);

  const handlePublish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onPublishNative) return;
    setPublishing(true);
    setPublishStatus(undefined);
    setPublishError(undefined);

    try {
      await onPublishNative({
        published: true,
        visibility,
        announcement: enableAnnouncement
          ? { mode: "broadcast", message: announcementMsg }
          : undefined,
      });
      setPublishStatus("Successfully published work to native destination.");
    } catch (err) {
      setPublishError(
        err instanceof Error ? err.message : "Failed to publish work.",
      );
    } finally {
      setPublishing(false);
    }
  };

  const handleConfirmUnpublish = async () => {
    if (!onPublishNative) return;
    setBusyUnpublish(true);
    setUnpublishError(undefined);

    try {
      await onPublishNative({
        published: false,
        visibility,
      });
      setShowUnpublishModal(false);
      setPublishStatus("Work has been unpublished and withdrawn from native destination.");
    } catch (err) {
      setUnpublishError(
        err instanceof Error ? err.message : "Failed to unpublish work.",
      );
    } finally {
      setBusyUnpublish(false);
    }
  };

  return (
    <div className="ubeeq-studio-publish-view">
      <header className="ubeeq-studio-view-header">
        <div>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="ubeeq-btn-link ubeeq-back-btn"
            >
              ← Back to Work
            </button>
          )}
          <h1>Publishing: {workTitle}</h1>
          <p className="ubeeq-studio-subtext">
            Manage distribution and publication channels in {brand.studioName}.
          </p>
        </div>
      </header>

      {/* Extension Slot: publishingPreFlightBannerSlot */}
      <ExtensionSlot
        name="publishingPreFlightBannerSlot"
        props={{ workId, destination: "native" }}
      />

      <div className="ubeeq-publish-status-box">
        <h3>Current Distribution Status</h3>
        <p>
          Native Publication:{" "}
          <strong
            className={
              isPublished ? "ubeeq-text-success" : "ubeeq-text-muted"
            }
          >
            {isPublished
              ? `Live (${nativePub?.visibility})`
              : "Not Published"}
          </strong>
        </p>
      </div>

      <form onSubmit={handlePublish} className="ubeeq-publish-form">
        <h2>Native Distribution Settings</h2>

        <div className="ubeeq-form-field">
          <label htmlFor="pub-visibility">Visibility</label>
          <select
            id="pub-visibility"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            disabled={publishing}
          >
            <option value="public">Public (Open to all visitors)</option>
            <option value="unlisted">Unlisted (Accessible by link)</option>
            <option value="private">Private (Restricted)</option>
          </select>
        </div>

        <div className="ubeeq-form-field ubeeq-checkbox-field">
          <label>
            <input
              type="checkbox"
              checked={enableAnnouncement}
              onChange={(e) => setEnableAnnouncement(e.target.checked)}
              disabled={publishing}
            />
            Schedule announcement upon publishing
          </label>
        </div>

        {enableAnnouncement && (
          <div className="ubeeq-form-field">
            <label htmlFor="announcement-msg">Announcement Message</label>
            <textarea
              id="announcement-msg"
              rows={3}
              placeholder="Check out my new work!"
              value={announcementMsg}
              onChange={(e) => setAnnouncementMsg(e.target.value)}
              disabled={publishing}
            />
          </div>
        )}

        {publishError && (
          <p className="ubeeq-form-error" role="alert">
            {publishError}
          </p>
        )}
        {publishStatus && (
          <p className="ubeeq-form-success">{publishStatus}</p>
        )}

        <div className="ubeeq-form-actions">
          <button
            type="submit"
            disabled={publishing}
            className="ubeeq-btn-primary"
          >
            {publishing ? "Publishing…" : isPublished ? "Update Publication" : "Publish Work"}
          </button>
          {isPublished && (
            <button
              type="button"
              onClick={() => setShowUnpublishModal(true)}
              disabled={publishing}
              className="ubeeq-btn-danger"
            >
              Unpublish Work
            </button>
          )}
        </div>
      </form>

      {/* Accessible Confirmation Modal for Unpublishing */}
      <ActionConfirmationDialog
        isOpen={showUnpublishModal}
        title="Unpublish Work"
        resourceName={workTitle}
        description={
          <p>
            Unpublishing will immediately withdraw this work from the native
            showcase and public feed in {brand.studioName}.
          </p>
        }
        irreversible={false}
        confirmLabel="Unpublish Work"
        cancelLabel="Keep Live"
        confirmTone="danger"
        busy={busyUnpublish}
        error={unpublishError}
        onCancel={() => {
          if (!busyUnpublish) {
            setShowUnpublishModal(false);
            setUnpublishError(undefined);
          }
        }}
        onConfirm={handleConfirmUnpublish}
      />
    </div>
  );
};
