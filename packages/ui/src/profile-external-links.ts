export type ProfileExternalLink = { label: string; url: string };
export type ProfileExternalLinkValidationIssue = { index: number; message: string };

export function validateProfileExternalLinks(value: ProfileExternalLink[], supportedDomains: Readonly<Record<string, readonly string[]>>, allowCustom = true): ProfileExternalLinkValidationIssue[] {
  const knownLabel = (label: string) => Object.keys(supportedDomains).find(candidate => candidate.toLowerCase() === label.trim().toLowerCase());
  return value.flatMap((link, index) => {
    const label = link.label.trim();
    const url = link.url.trim();
    if (!label) return [{ index, message: `External link ${index + 1} needs a platform or label.` }];
    if (!url) return [{ index, message: `${label} needs a URL.` }];
    let parsed: URL;
    try { parsed = new URL(url); } catch { return [{ index, message: `${label} needs a valid http:// or https:// URL.` }]; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return [{ index, message: `${label} needs a valid http:// or https:// URL.` }];
    const platform = knownLabel(label);
    if (!platform && !allowCustom) return [{ index, message: `${label} is not a supported member-profile platform.` }];
    const domains = platform ? supportedDomains[platform] : undefined;
    if (domains && !domains.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`))) {
      return [{ index, message: `${label} links must use ${domains.map((domain) => `“${domain}”`).join(' or ')}.` }];
    }
    return [];
  });
}
