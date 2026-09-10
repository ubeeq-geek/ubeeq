const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

const sanitizeNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent || '').replace(/\r?\n/g, '<br>');
  if (!(node instanceof HTMLElement)) return '';
  const tag = node.tagName.toLowerCase();
  const children = Array.from(node.childNodes).map(sanitizeNode).join('');
  if (tag === 'br') return '<br>';
  if (tag === 'strong' || tag === 'b') return `<strong>${children}</strong>`;
  if (tag === 'em' || tag === 'i') return `<em>${children}</em>`;
  if (tag === 'u') return `<u>${children}</u>`;
  if (tag === 'div' || tag === 'p' || tag === 'li') return `${children}<br>`;
  return children;
};

/** Limited biography formatting compatibility; product character limits remain external. */
export const sanitizeProfileBio = (value: string): string => {
  if (!value) return '';
  if (typeof DOMParser === 'undefined') return escapeHtml(value).replace(/\r?\n/g, '<br>');
  const document = new DOMParser().parseFromString(`<body>${value}</body>`, 'text/html');
  return Array.from(document.body.childNodes).map(sanitizeNode).join('').replace(/(?:<br>){3,}/g, '<br><br>');
};

export const profileBioToText = (value: string): string => {
  if (!value) return '';
  if (typeof DOMParser === 'undefined') return value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
  const document = new DOMParser().parseFromString(`<body>${sanitizeProfileBio(value)}</body>`, 'text/html');
  document.body.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  return document.body.textContent || '';
};
