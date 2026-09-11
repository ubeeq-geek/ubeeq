import { useEffect, useRef, useState } from 'react';

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
  const toggle = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open && !disabled) (list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?? list.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [open, disabled]);
  const close = () => { setOpen(false); toggle.current?.focus(); };
  if (!options.length) return null;
  const resolvedPreset = selectedPreset;
  const assignedCover = previewUrl;
  const selectedLabel = options.find(option => option.id === resolvedPreset)?.label || emptyLabel;

  return (
    <section className="studio-cover-preset-picker">
      <button
        type="button"
        ref={toggle}
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
        <div ref={list} className="studio-cover-preset-options" role="listbox" aria-label={optionsLabel}
          onKeyDown={event => {
            if (disabled) return;
            if (event.key === 'Escape') { event.preventDefault(); close(); return; }
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
            const index = buttons.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            const next = event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1)
              : event.key === 'ArrowUp' ? Math.max(index - 1, 0)
              : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : undefined;
            if (next !== undefined) {
              event.preventDefault(); buttons.forEach((button, position) => { button.tabIndex = position === next ? 0 : -1; });
              buttons[next]?.focus();
            }
          }}>
          {options.map((option) => {
            const selected = option.id === resolvedPreset;
            return (
              <button
                type="button"
                role="option"
                disabled={disabled}
                aria-selected={selected}
                tabIndex={selected || (!options.some(item => item.id === resolvedPreset) && option === options[0]) ? 0 : -1}
                className={selected ? 'is-selected' : ''}
                key={option.id}
                onClick={() => {
                  if (disabled) return;
                  onChange(option.id);
                  close();
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
