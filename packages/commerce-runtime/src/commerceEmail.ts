import type { CommercePorts } from '@ubeeq/commerce';
import type { StorefrontBrandConfig } from './brandConfig.js';

type Message = Parameters<CommercePorts['mail']['send']>[0];

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function renderCommerceCodeEmail(code: string, brand: StorefrontBrandConfig): { text: string; html: string } {
  if (!/^\d{6}$/.test(code)) throw new Error('Invalid verification code.');
  const name = escape(brand.productName);
  const tagline = escape(brand.tagline ?? 'Self-hosted creator commerce');
  const accent = brand.accentColor ?? '#225e47';
  const monogram = brand.productName.charAt(0).toUpperCase();

  const text = `${brand.productName}\n\nYour ${brand.productName} sign-in code is ${code}.\n\nEnter this code on the sign-in page to continue.\n\nThis code expires in 10 minutes and can only be used once. If you did not request it, you can ignore this email.\n\nKeep this code private.\n\n${brand.productName} · ${brand.tagline ?? 'Self-hosted creator commerce'}`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your ${name} sign-in code</title></head><body style="margin:0;padding:0;background:#f6f5fa;color:#1a1626;font-family:system-ui,-apple-system,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f6f5fa"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px"><tr><td style="padding:0 8px 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="44" align="center" bgcolor="${accent}" style="border-radius:50%;font-size:24px;font-weight:bold;color:#fff">${monogram}</td><td style="padding-left:12px"><span style="font-size:24px;font-weight:bold;letter-spacing:-1px">${name}</span><br><span style="font-size:11px;line-height:18px;letter-spacing:1px;color:#6b6580">${tagline}</span></td></tr></table></td></tr><tr><td bgcolor="#ffffff" style="padding:32px;border:1px solid #e5e1ed;border-radius:16px"><p style="margin:0 0 12px;color:${accent};font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase">Your account</p><h1 style="margin:0 0 20px;font-size:28px;line-height:36px">Your sign-in code</h1><p style="margin:0 0 24px;font-size:16px;line-height:26px;color:#6b6580">Enter this code on the sign-in page to continue.</p><p style="margin:0 0 24px;padding:20px 12px;border:1px solid #e5e1ed;border-radius:12px;background:#f6f5fa;text-align:center;color:${accent};font-family:Consolas,monospace;font-size:36px;font-weight:bold;letter-spacing:6px">${code}</p><p style="margin:0 0 12px;font-size:14px;line-height:22px;color:#6b6580">This code expires in 10 minutes and can only be used once.</p><p style="margin:0;font-size:14px;line-height:22px;color:#6b6580">If you did not request this email, you can safely ignore it.</p></td></tr><tr><td align="center" style="padding:24px 16px;font-size:12px;line-height:20px;color:#6b6580">${name} · ${tagline}<br>Keep this sign-in code private.</td></tr></table></td></tr></table></body></html>`;

  return { text, html };
}

const templates: Record<string, { path: string; button: string; description: string; expiry: string }> = {
  'Sign in to your purchases': {
    path: 'sign-in',
    button: 'Sign in to your purchases',
    description: 'Use this secure link to sign in and access collections, subscriptions, gifts, and downloads.',
    expiry: '15 minutes',
  },
  'Claim your purchase': {
    path: 'claim',
    button: 'Claim your purchase',
    description: 'Use this secure link to claim your purchase and keep it accessible from your account.',
    expiry: '24 hours',
  },
  'Verify your recovery email': {
    path: 'verify-email',
    button: 'Verify your email',
    description: 'Confirm this email address so you can securely return to your purchases and recover access.',
    expiry: '1 hour',
  },
};

export function renderCommerceTransactionalEmail(
  message: Message,
  brand: StorefrontBrandConfig,
  publicBaseUrl: string
): Message {
  const template = templates[message.subject];
  if (!template) return message;

  let link: URL;
  try {
    link = new URL(message.text.trim());
    const base = new URL(publicBaseUrl);
    if (
      !['https:', 'http:'].includes(link.protocol) ||
      link.origin !== base.origin ||
      link.username ||
      link.password ||
      link.pathname !== base.pathname.replace(/\/$/, '') + '/commerce/' + template.path ||
      !link.searchParams.get('id') ||
      !link.searchParams.get('token')
    ) {
      return message;
    }
  } catch {
    return message;
  }

  const title = message.subject;
  const name = brand.productName;
  const tagline = brand.tagline ?? 'Self-hosted creator commerce';
  const accent = brand.accentColor ?? '#225e47';
  const monogram = brand.productName.charAt(0).toUpperCase();
  const expiry = `This link expires in ${template.expiry} and can only be used once.`;
  const ignore = 'If you did not request this email, you can safely ignore it.';
  const url = link.href;

  const text = `${name}\n\n${title}\n\n${template.description}\n\n${template.button}:\n${url}\n\n${expiry}\n\n${ignore}\n\n${name} · ${tagline}`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · ${escape(name)}</title></head><body style="margin:0;padding:0;background:#f6f5fa;color:#1a1626;font-family:system-ui,-apple-system,sans-serif;-webkit-text-size-adjust:100%"><div style="display:none;font-size:1px;color:#f6f5fa;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${escape(title)}. Your secure link expires in ${template.expiry}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f6f5fa"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px"><tr><td style="padding:0 8px 24px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="44" align="center" bgcolor="${accent}" style="width:44px;height:44px;border-radius:50%;font-size:24px;font-weight:bold;color:#ffffff">${monogram}</td><td style="padding-left:12px"><span style="font-size:24px;line-height:30px;font-weight:bold;letter-spacing:-1px;color:#1a1626">${escape(name)}</span><br><span style="font-size:11px;line-height:18px;letter-spacing:1px;color:#6b6580">${escape(tagline)}</span></td></tr></table></td></tr>
<tr><td bgcolor="#ffffff" style="padding:32px;border:1px solid #e5e1ed;border-radius:16px"><p style="margin:0 0 12px;color:${accent};font-size:12px;line-height:18px;font-weight:bold;letter-spacing:1px;text-transform:uppercase">Purchases &amp; access</p><h1 style="margin:0 0 20px;font-size:28px;line-height:36px;letter-spacing:-.5px;color:#1a1626">${escape(title)}</h1><p style="margin:0 0 24px;font-size:16px;line-height:26px;color:#6b6580">${escape(template.description)}</p><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${accent}" style="border-radius:28px;mso-padding-alt:14px 24px"><a href="${escape(url)}" style="display:inline-block;padding:14px 24px;border:1px solid ${accent};border-radius:28px;background:${accent};color:#ffffff;font-size:16px;line-height:22px;font-weight:bold;text-decoration:none;mso-padding-alt:0">${escape(template.button)}</a></td></tr></table><p style="margin:24px 0 0;font-size:14px;line-height:22px;color:#6b6580">${escape(expiry)}</p><p style="margin:12px 0 24px;font-size:14px;line-height:22px;color:#6b6580">${escape(ignore)}</p><div style="border-top:1px solid #e5e1ed;padding-top:20px"><p style="margin:0 0 8px;font-size:12px;line-height:20px;color:#6b6580">If the button doesn’t work, copy and paste this link into your browser:</p><p style="margin:0;font-size:12px;line-height:20px;overflow-wrap:anywhere;word-break:break-all"><a href="${escape(url)}" style="color:${accent};text-decoration:underline;word-break:break-all">${escape(url)}</a></p></div></td></tr><tr><td align="center" style="padding:24px 16px;color:#6b6580;font-size:12px;line-height:20px">${escape(name)} · ${escape(tagline)}<br>Keep this sign-in link private.</td></tr></table></td></tr></table></body></html>`;

  return { ...message, text, html };
}
