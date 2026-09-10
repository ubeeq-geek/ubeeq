export type ProfileLinkValue = { label: string; url: string };

/** Structured draft fields. Saving, authorization and URL policy belong to the caller. */
export function createProfileLinkEditor({ panel, maxLinks, maxLabelLength, maxUrlLength, buttonClassName = '' }: {
  panel: HTMLElement; maxLinks: number; maxLabelLength: number; maxUrlLength: number; buttonClassName?: string;
}) {
  if (![maxLinks, maxLabelLength, maxUrlLength].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Positive field limits are required.');
  const document = panel.ownerDocument;
  let rows: { row: HTMLFieldSetElement; label: HTMLInputElement; url: HTMLInputElement }[] = [];
  const list = document.createElement('div'), count = document.createElement('p'), add = document.createElement('button');
  count.setAttribute('aria-live', 'polite');
  add.type = 'button'; add.className = buttonClassName; add.textContent = 'Add external link';
  panel.replaceChildren(list, count, add);
  const refresh = () => {
    count.textContent = `${rows.length} of ${maxLinks} links`;
    add.disabled = rows.length >= maxLinks;
    rows.forEach((item, index) => {
      item.label.setAttribute('aria-label', `External link ${index + 1} label`);
      item.url.setAttribute('aria-label', `External link ${index + 1} URL`);
    });
  };
  const append = (value: ProfileLinkValue) => {
    const row = document.createElement('fieldset'), label = document.createElement('input'), url = document.createElement('input');
    const labelText = document.createElement('label'), urlText = document.createElement('label'), remove = document.createElement('button');
    labelText.textContent = 'Label'; urlText.textContent = 'URL';
    label.type = 'text'; label.required = true; label.maxLength = maxLabelLength; label.value = value.label;
    url.type = 'url'; url.required = true; url.maxLength = maxUrlLength; url.value = value.url;
    labelText.append(label); urlText.append(url);
    remove.type = 'button'; remove.className = buttonClassName; remove.textContent = 'Remove link';
    const item = { row, label, url }; rows.push(item);
    remove.addEventListener('click', () => {
      const index = rows.indexOf(item);
      if (index < 0) return;
      rows.splice(index, 1); row.remove(); refresh();
      (rows[index]?.label ?? rows[index - 1]?.label ?? add).focus();
    });
    row.append(labelText, urlText, remove); list.append(row); refresh();
    return label;
  };
  add.addEventListener('click', () => { if (rows.length < maxLinks) append({ label: '', url: '' }).focus(); });
  refresh();
  return {
    setValue(value: readonly ProfileLinkValue[]) {
      // Do not truncate retained data, even when a product lowers its limit.
      rows = []; list.replaceChildren(); value.forEach(append); refresh();
    },
    getValue(): ProfileLinkValue[] { return rows.map(({ label, url }) => ({ label: label.value, url: url.value })); }
  };
}
