import React, { createContext, useContext, type ReactNode } from "react";

export interface StudioBrandConfig {
  /** Full Studio product name (never shortened to "Studio", e.g. "Ubeeq Studio"). */
  studioName: string;
  brandMarkSvg?: ReactNode;
  theme?: "light" | "dark" | "system";
  tokens?: Record<string, string>;
  navigationExtra?: Array<{ label: string; href: string }>;
  supportHelpUrl?: string;
}

export const defaultStudioBrand: StudioBrandConfig = Object.freeze({
  studioName: "Ubeeq Studio",
  theme: "system",
});

export const StudioBrandContext = createContext<StudioBrandConfig>(defaultStudioBrand);

export const useStudioBrand = (): StudioBrandConfig => useContext(StudioBrandContext);

export const StudioBrandProvider: React.FC<{
  brand?: Partial<StudioBrandConfig>;
  children: ReactNode;
}> = ({ brand, children }) => {
  const merged: StudioBrandConfig = {
    ...defaultStudioBrand,
    ...brand,
    studioName: brand?.studioName || defaultStudioBrand.studioName,
  };
  return <StudioBrandContext.Provider value={merged}>{children}</StudioBrandContext.Provider>;
};
