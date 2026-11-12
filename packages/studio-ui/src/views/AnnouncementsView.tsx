import React, { useState } from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";
import { ActionConfirmationDialog } from "../components/ActionConfirmationDialog.js";

export interface AnnouncementItem {
  id: string;
  title: string;
  message: string;
  status: "draft" | "scheduled" | "delivered" | "failed" | string;
  channels: string[];
  scheduledAt?: string;
  deliveredAt?: string;
}

export interface AnnouncementsViewProps {
  announcements: AnnouncementItem[];
  onCreateAnnouncement?: (input: {
    title: string;
    message: string;
    channels: string[];
    scheduledAt?: string;
  }) => Promise<void> | void;
  onCancelAnnouncement?: (id: string) => Promise<void> | void;
  loading?: boolean;
}

export const AnnouncementsView: React.FC<AnnouncementsViewProps> = ({
  announcements,
  onCreateAnnouncement,
  onCancelAnnouncement,
  loading = false,
}) => {
  const brand = useStudioBrand();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [channelEmail, setChannelEmail] = useState(true);
  const [channelFeed, setChannelFeed] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>();

  const [toCancel, setToCancel] = useState<AnnouncementItem | null>(null);
  const [busyCancel, setBusyCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | undefined>();

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !message.trim() || !onCreateAnnouncement) return;
    setIsCreating(true);
    setCreateError(undefined);

    const channels: string[] = [];
    if (channelFeed) channels.push("feed");
    if (channelEmail) channels.push("email");

    try {
      await onCreateAnnouncement({
        title: title.trim(),
        message: message.trim(),
        channels,
      });
      setTitle("");
      setMessage("");
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create announcement.",
      );
    } finally {
      setIsCreating(false);
    }
  };

  const handleConfirmCancel = async () => {
    if (!toCancel || !onCancelAnnouncement) return;
    setBusyCancel(true);
    setCancelError(undefined);
    try {
      await onCancelAnnouncement(toCancel.id);
      setToCancel(null);
    } catch (err) {
      setCancelError(
        err instanceof Error ? err.message : "Failed to cancel announcement.",
      );
    } finally {
      setBusyCancel(false);
    }
  };

  return (
    <div className="ubeeq-studio-announcements-view">
      <header className="ubeeq-studio-view-header">
        <div>
          <h1>Announcements</h1>
          <p>
            Communicate updates to your audience and subscribers through{" "}
            {brand.studioName}.
          </p>
        </div>
      </header>

      {onCreateAnnouncement && (
        <form onSubmit={handleCreate} className="ubeeq-announcement-create-card">
          <h2>Create New Announcement</h2>
          <div className="ubeeq-form-field">
            <label htmlFor="ann-title">Subject / Title</label>
            <input
              id="ann-title"
              type="text"
              placeholder="Exciting new release!"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isCreating}
              required
            />
          </div>

          <div className="ubeeq-form-field">
            <label htmlFor="ann-msg">Message Body</label>
            <textarea
              id="ann-msg"
              rows={4}
              placeholder="Write your announcement message here…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={isCreating}
              required
            />
          </div>

          <div className="ubeeq-channels-selection">
            <label>
              <input
                type="checkbox"
                checked={channelFeed}
                onChange={(e) => setChannelFeed(e.target.checked)}
                disabled={isCreating}
              />
              Publish to Subscriber Feed
            </label>
            <label>
              <input
                type="checkbox"
                checked={channelEmail}
                onChange={(e) => setChannelEmail(e.target.checked)}
                disabled={isCreating}
              />
              Broadcast to Mailing List
            </label>
          </div>

          {createError && (
            <p className="ubeeq-form-error" role="alert">
              {createError}
            </p>
          )}

          <button
            type="submit"
            disabled={!title.trim() || !message.trim() || isCreating}
            className="ubeeq-btn-primary"
          >
            {isCreating ? "Scheduling…" : "Send Announcement"}
          </button>
        </form>
      )}

      <h2>Announcement History</h2>
      {loading ? (
        <p className="ubeeq-loading">Loading announcements…</p>
      ) : announcements.length === 0 ? (
        <div className="ubeeq-empty-state">
          <p>No announcements broadcast yet.</p>
        </div>
      ) : (
        <ul className="ubeeq-announcements-list">
          {announcements.map((item) => (
            <li key={item.id} className="ubeeq-announcement-card">
              <div className="ubeeq-announcement-content">
                <h3>{item.title}</h3>
                <p>{item.message}</p>
                <div className="ubeeq-announcement-meta">
                  <span className={`ubeeq-status-badge ubeeq-status-${item.status}`}>
                    {item.status}
                  </span>
                  <span>Channels: {item.channels.join(", ")}</span>
                  {item.deliveredAt && (
                    <span>
                      Delivered: {new Date(item.deliveredAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              {onCancelAnnouncement && item.status === "scheduled" && (
                <div className="ubeeq-announcement-actions">
                  <button
                    type="button"
                    onClick={() => setToCancel(item)}
                    className="ubeeq-btn-danger-sm"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Accessible Confirmation Modal for Cancelling Scheduled Announcement */}
      <ActionConfirmationDialog
        isOpen={toCancel !== null}
        title="Cancel Announcement"
        resourceName={toCancel?.title}
        description={
          <p>
            Cancelling will prevent this scheduled announcement from broadcasting to
            subscribers in {brand.studioName}.
          </p>
        }
        irreversible={true}
        confirmLabel="Cancel Announcement"
        cancelLabel="Keep Scheduled"
        confirmTone="danger"
        busy={busyCancel}
        error={cancelError}
        onCancel={() => {
          if (!busyCancel) {
            setToCancel(null);
            setCancelError(undefined);
          }
        }}
        onConfirm={handleConfirmCancel}
      />
    </div>
  );
};
