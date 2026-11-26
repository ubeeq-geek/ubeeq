import React, { useEffect, useId, useRef, type ReactNode } from "react";

export interface ActionConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  resourceName?: string;
  description: ReactNode;
  irreversible?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmTone?: "danger" | "primary";
  busy?: boolean;
  busyLabel?: string;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}

export function ActionConfirmationDialog({
  isOpen,
  title,
  resourceName,
  description,
  irreversible = false,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmTone = "danger",
  busy = false,
  busyLabel = "Processing…",
  error,
  onCancel,
  onConfirm,
}: ActionConfirmationDialogProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
      // Focus Cancel button initially as mandated by accessibility rules
      cancelBtnRef.current?.focus();
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBackdropClick = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialogRef.current && !busy) {
      onCancel();
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) {
        onCancel();
      }
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="ubeeq-action-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
    >
      <div className="ubeeq-action-dialog-content">
        <h2 id={titleId} className="ubeeq-action-dialog-title">
          {title}
        </h2>
        {resourceName && (
          <div className="ubeeq-action-dialog-resource">
            <strong>Resource:</strong> {resourceName}
          </div>
        )}
        <div id={descriptionId} className="ubeeq-action-dialog-description">
          {description}
          {irreversible && (
            <p className="ubeeq-action-dialog-irreversible">
              This action cannot be undone.
            </p>
          )}
        </div>

        {error && (
          <p className="ubeeq-action-dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="ubeeq-action-dialog-actions">
          <button
            type="button"
            ref={cancelBtnRef}
            className="ubeeq-dialog-btn ubeeq-dialog-btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`ubeeq-dialog-btn ubeeq-dialog-btn-${confirmTone}`}
            disabled={busy}
            aria-busy={busy}
            onClick={() => void onConfirm()}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
