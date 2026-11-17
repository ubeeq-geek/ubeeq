import React, { useState } from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";
import { ActionConfirmationDialog } from "../components/ActionConfirmationDialog.js";

export interface ConnectorItem {
  id: string;
  name: string;
  category: "social" | "video" | "blog" | "audience" | "storage";
  connected: boolean;
  accountName?: string;
  lastSyncedAt?: string;
}

export const KNOWN_CONNECTORS: Omit<ConnectorItem, "connected">[] = [
  { id: "youtube", name: "YouTube", category: "video" },
  { id: "instagram", name: "Instagram", category: "social" },
  { id: "tiktok", name: "TikTok", category: "video" },
  { id: "facebook", name: "Facebook", category: "social" },
  { id: "x", name: "X (Twitter)", category: "social" },
  { id: "threads", name: "Threads", category: "social" },
  { id: "pinterest", name: "Pinterest", category: "social" },
  { id: "linkedin", name: "LinkedIn", category: "social" },
  { id: "substack", name: "Substack", category: "blog" },
  { id: "patreon", name: "Patreon", category: "audience" },
  { id: "fanvue", name: "Fanvue", category: "audience" },
  { id: "flickr", name: "Flickr", category: "storage" },
  { id: "smugmug", name: "SmugMug", category: "storage" },
  { id: "vimeo", name: "Vimeo", category: "video" },
  { id: "wordpress", name: "WordPress", category: "blog" },
  { id: "ghost", name: "Ghost", category: "blog" },
  { id: "reddit", name: "Reddit", category: "social" },
  { id: "bunny", name: "Bunny.net", category: "storage" },
  { id: "bluesky", name: "Bluesky", category: "social" },
];

export interface ConnectorsViewProps {
  connectors?: ConnectorItem[];
  onConnect?: (connectorId: string) => Promise<void> | void;
  onDisconnect?: (connectorId: string) => Promise<void> | void;
  loading?: boolean;
}

export const ConnectorsView: React.FC<ConnectorsViewProps> = ({
  connectors = [],
  onConnect,
  onDisconnect,
  loading = false,
}) => {
  const brand = useStudioBrand();
  const [toDisconnect, setToDisconnect] = useState<ConnectorItem | null>(null);
  const [busyDisconnect, setBusyDisconnect] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | undefined>();

  // Merge known catalog with connected states
  const items: ConnectorItem[] = KNOWN_CONNECTORS.map((known) => {
    const existing = connectors.find((c) => c.id === known.id);
    return (
      existing || {
        ...known,
        connected: false,
      }
    );
  });

  const handleConfirmDisconnect = async () => {
    if (!toDisconnect || !onDisconnect) return;
    setBusyDisconnect(true);
    setDisconnectError(undefined);
    try {
      await onDisconnect(toDisconnect.id);
      setToDisconnect(null);
    } catch (err) {
      setDisconnectError(
        err instanceof Error ? err.message : "Failed to disconnect channel.",
      );
    } finally {
      setBusyDisconnect(false);
    }
  };

  return (
    <div className="ubeeq-studio-connectors-view">
      <header className="ubeeq-studio-view-header">
        <div>
          <h1>External Connectors</h1>
          <p>
            Connect third-party networks and destinations to {brand.studioName} using
            bring-your-own credentials or platform integrations.
          </p>
        </div>
      </header>

      {loading ? (
        <p className="ubeeq-loading">Loading connector statuses…</p>
      ) : (
        <div className="ubeeq-connectors-grid">
          {items.map((conn) => (
            <div key={conn.id} className="ubeeq-connector-card">
              <div className="ubeeq-connector-header">
                <h3>{conn.name}</h3>
                <span
                  className={`ubeeq-status-badge ${
                    conn.connected
                      ? "ubeeq-status-live"
                      : "ubeeq-status-disconnected"
                  }`}
                >
                  {conn.connected ? "Connected" : "Not Connected"}
                </span>
              </div>
              <p className="ubeeq-connector-category">Category: {conn.category}</p>
              {conn.accountName && (
                <p className="ubeeq-connector-account">Account: {conn.accountName}</p>
              )}
              {conn.lastSyncedAt && (
                <p className="ubeeq-connector-sync">
                  Last synced: {new Date(conn.lastSyncedAt).toLocaleString()}
                </p>
              )}

              <div className="ubeeq-connector-actions">
                {conn.connected ? (
                  onDisconnect && (
                    <button
                      type="button"
                      onClick={() => setToDisconnect(conn)}
                      className="ubeeq-btn-danger-sm"
                    >
                      Disconnect
                    </button>
                  )
                ) : (
                  onConnect && (
                    <button
                      type="button"
                      onClick={() => void onConnect(conn.id)}
                      className="ubeeq-btn-primary-sm"
                    >
                      Connect
                    </button>
                  )
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Accessible Confirmation Modal for Disconnecting Channel */}
      <ActionConfirmationDialog
        isOpen={toDisconnect !== null}
        title="Disconnect Connector"
        resourceName={toDisconnect?.name}
        description={
          <p>
            Disconnecting <strong>{toDisconnect?.name}</strong> will revoke access
            tokens and halt automatic sync in {brand.studioName}.
          </p>
        }
        irreversible={false}
        confirmLabel="Disconnect"
        cancelLabel="Keep Connected"
        confirmTone="danger"
        busy={busyDisconnect}
        error={disconnectError}
        onCancel={() => {
          if (!busyDisconnect) {
            setToDisconnect(null);
            setDisconnectError(undefined);
          }
        }}
        onConfirm={handleConfirmDisconnect}
      />
    </div>
  );
};
