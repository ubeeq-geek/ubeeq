export interface LegacyCustomerAccountConfig {
  idHashNamespace: string;      // e.g. 'legacy-member:'
  idPrefix: string;             // e.g. 'legacy-'
  ownerId: string;              // e.g. 'legacy-members'
  sessionCookieName: string;    // e.g. 'legacy.member.session'
  passwordRibbonLabel?: string;
  accountLabel?: string;
}

export interface StorefrontBrandConfig {
  brandId: string;              // default: 'ubeeq'
  productName: string;          // default: 'Ubeeq'
  studioName: string;           // default: 'Ubeeq Studio'
  tagline?: string;             // default: 'Self-hosted creator commerce'
  supportEmail?: string;
  logoSvg?: string;             // optional SVG mark markup
  faviconSvg?: string;
  themeCss?: string;
  accentColor?: string;         // default: '#225e47'
  navigation?: Array<{ label: string; href: string }>;
  accountConfig?: {
    idHashNamespace: string;    // default: 'ubeeq-customer:'
    idPrefix: string;           // default: 'cust-'
    ownerId: string;            // default: 'instance-customers'
    sessionCookieName: string;  // default: 'ubeeq.customer.session'
    accountLabel?: string;      // default: 'Customer account'
  };
  legacyCustomerAccountConfig?: LegacyCustomerAccountConfig;
  clientEnhancements?: string;
}

export interface ResolvedStorefrontAccountConfig {
  idHashNamespace: string;
  idPrefix: string;
  ownerId: string;
  sessionCookieName: string;
  accountLabel: string;
}

export const resolveStorefrontAccountConfig = (brand?: StorefrontBrandConfig): ResolvedStorefrontAccountConfig => {
  if (brand?.legacyCustomerAccountConfig) {
    return {
      idHashNamespace: brand.legacyCustomerAccountConfig.idHashNamespace,
      idPrefix: brand.legacyCustomerAccountConfig.idPrefix,
      ownerId: brand.legacyCustomerAccountConfig.ownerId,
      sessionCookieName: brand.legacyCustomerAccountConfig.sessionCookieName,
      accountLabel: brand.legacyCustomerAccountConfig.accountLabel ?? "Customer account",
    };
  }
  return {
    idHashNamespace: brand?.accountConfig?.idHashNamespace ?? "ubeeq-customer:",
    idPrefix: brand?.accountConfig?.idPrefix ?? "cust-",
    ownerId: brand?.accountConfig?.ownerId ?? "instance-customers",
    sessionCookieName: brand?.accountConfig?.sessionCookieName ?? "ubeeq.customer.session",
    accountLabel: brand?.accountConfig?.accountLabel ?? "Customer account",
  };
};
