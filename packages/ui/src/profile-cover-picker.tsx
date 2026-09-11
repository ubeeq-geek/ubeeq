import { useState } from 'react';

export interface ProfileCoverPickerProps {
  options: readonly { id: string; label: string; url: string }[];
  selectedPreset?: string;
  previewUrl?: string;
  disabled?: boolean;
  title: string;
  description: string;
  emptyLabel?: string;
  optionsLabel?: string;
  onChange: (preset: string) => void;
}

export function ProfileCoverPicker({ options, selectedPreset, previewUrl, disabled = false, title, description,
  emptyLabel = 'Choose a cover', optionsLabel = 'Available cover images', onChange }: ProfileCoverPickerProps) {
  const [open, setOpen] = useState(false);
  if (!options.length) return null;
  const resolvedPreset = selectedPreset;
  const assignedCover = previewUrl;
  const selectedLabel = options.find(option => option.id === resolvedPreset)?.label || emptyLabel;

  return (
    <section className="studio-cover-preset-picker">
      <button
        type="button"
        className="studio-cover-preset-toggle"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {assignedCover && <img src={assignedCover} alt="" />}
        <span>
          <strong>{title}</strong>
          <small>{selectedLabel}</small>
        </span>
        <span className="studio-cover-preset-chevron" aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>
      {open && (
        <div className="studio-cover-preset-options" role="listbox" aria-label={optionsLabel}>
          {options.map((option) => {
            const selected = option.id === resolvedPreset;
            return (
              <button
                type="button"
                role="option"
                disabled={disabled}
                aria-selected={selected}
                className={selected ? 'is-selected' : ''}
                key={option.id}
                onClick={() => {
                  if (disabled) return;
                  onChange(option.id);
                  setOpen(false);
                }}
              >
                <img src={option.url} alt="" />
                <span>{option.label}</span>
                {selected && <b aria-hidden="true">✓</b>}
              </button>
            );
          })}
        </div>
      )}
      <p>{description}</p>
    </section>
  );
}
