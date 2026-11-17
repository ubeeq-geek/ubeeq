import React, { createContext, useContext, type ComponentType, type ReactNode } from "react";

export interface StudioUiExtensionComponents {
  workDetailActionsSlot?: ComponentType<{ workId: string; creatorId: string }>;
  assetToolbarSlot?: ComponentType<{ assetId: string; workId: string }>;
  creatorSettingsTabsSlot?: ComponentType<{ creatorId: string }>;
  accountBillingPanelSlot?: ComponentType<{ creatorId: string }>;
  publishingPreFlightBannerSlot?: ComponentType<{ workId: string; destination: string }>;
  supportDrawerSlot?: ComponentType<{ isOpen: boolean; onClose: () => void }>;
}

export const StudioExtensionSlotsContext = createContext<StudioUiExtensionComponents>({});

export const useStudioExtensionSlots = (): StudioUiExtensionComponents =>
  useContext(StudioExtensionSlotsContext);

export const StudioExtensionSlotsProvider: React.FC<{
  slots?: StudioUiExtensionComponents;
  children: ReactNode;
}> = ({ slots = {}, children }) => (
  <StudioExtensionSlotsContext.Provider value={slots}>{children}</StudioExtensionSlotsContext.Provider>
);

export function ExtensionSlot<K extends keyof StudioUiExtensionComponents>({
  name,
  props,
}: {
  name: K;
  props?: any;
}): React.ReactElement | null {
  const slots = useStudioExtensionSlots();
  const Component = slots[name];
  if (!Component) return null;
  return React.createElement(Component as ComponentType<any>, props);
}

