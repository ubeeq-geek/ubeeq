import { useState } from 'react';
import type { ProfileExternalLink } from './profile-external-links.js';

export function ProfileExternalLinksEditor({
  value,
  onChange,
  maxLinks,
  linkPresetGroups,
  linkExamples = {},
  maxLabelLength,
  maxUrlLength,
  allowCustom = true,
  invalidIndexes = []
}: {
  value: ProfileExternalLink[];
  onChange: (value: ProfileExternalLink[]) => void;
  maxLinks: number;
  linkPresetGroups: readonly { label: string; links: readonly string[] }[];
  linkExamples?: Readonly<Record<string, string>>;
  maxLabelLength: number;
  maxUrlLength: number;
  allowCustom?: boolean;
  invalidIndexes?: number[];
}) {
  const [presetQuery, setPresetQuery] = useState('');
  const [presetCategory, setPresetCategory] = useState('all');
  const normalizedPresetQuery = presetQuery.trim().toLowerCase();
  const filteredPresetGroups = linkPresetGroups.flatMap((group) => {
    if (presetCategory !== 'all' && presetCategory !== group.label) return [];
    const links = !normalizedPresetQuery || group.label.toLowerCase().includes(normalizedPresetQuery)
      ? group.links
      : group.links.filter((label) => label.toLowerCase().includes(normalizedPresetQuery));
    return links.length ? [{ ...group, links }] : [];
  });
  const update = (index: number, patch: Partial<ProfileExternalLink>) => {
    onChange(value.map((link, linkIndex) => linkIndex === index ? { ...link, ...patch } : link));
  };
  const add = (label = '') => {
    if (value.length >= maxLinks) return;
    onChange([...value, { label, url: '' }]);
  };
  const remove = (index: number) => onChange(value.filter((_, linkIndex) => linkIndex !== index));

  return (
    <div className="profile-external-links-editor">
      <div className="profile-external-link-rows">
        {value.map((link, index) => (
          <div className="profile-external-link-row" key={`external-link-${index}`}>
            <input
              aria-label={`External link ${index + 1} label`}
              value={link.label}
              onChange={allowCustom ? (event) => update(index, { label: event.target.value }) : undefined}
              placeholder="Label"
              maxLength={maxLabelLength}
              readOnly={!allowCustom}
              aria-invalid={invalidIndexes.includes(index) || undefined}
            />
            <input
              aria-label={`External link ${index + 1} URL`}
              type="url"
              value={link.url}
              onChange={(event) => update(index, { url: event.target.value })}
              placeholder={linkExamples[link.label] || (allowCustom ? 'https://example.com/profile' : 'Choose a supported platform below')}
              maxLength={maxUrlLength}
              aria-invalid={invalidIndexes.includes(index) || undefined}
            />
            <button type="button" className="profile-external-link-remove" onClick={() => remove(index)} aria-label={`Remove ${link.label || `link ${index + 1}`}`}>×</button>
          </div>
        ))}
        {value.length === 0 && <p className="small m-0">No external links added yet.</p>}
      </div>
      <div className="profile-external-link-add">
        <span>{allowCustom ? 'Add a link' : 'Add a platform'}</span>
        <div className="profile-external-link-filters">
          <input
            type="search"
            aria-label="Filter external link platforms"
            value={presetQuery}
            onChange={(event) => setPresetQuery(event.target.value)}
            placeholder="Filter platforms…"
          />
          <select
            aria-label="Filter external link platform category"
            value={presetCategory}
            onChange={(event) => setPresetCategory(event.target.value)}
          >
            <option value="all">All categories</option>
            {linkPresetGroups.map((group) => <option value={group.label} key={group.label}>{group.label}</option>)}
          </select>
        </div>
        <div className="profile-external-link-preset-groups">
          {filteredPresetGroups.map((group) => (
            <div className="profile-external-link-preset-group" key={group.label}>
              <span>{group.label}</span>
              <div className="profile-external-link-preset-buttons">
                {group.links.map((label) => <button type="button" key={label} disabled={value.length >= maxLinks} onClick={() => add(label)}>{label}</button>)}
              </div>
            </div>
          ))}
          {filteredPresetGroups.length === 0 && <p className="small m-0">No platforms match this filter.</p>}
          {allowCustom && <button type="button" className="is-custom" disabled={value.length >= maxLinks} onClick={() => add('')}>+ Custom URL</button>}
        </div>
        <small>{value.length} of {maxLinks} links</small>
      </div>
    </div>
  );
}
