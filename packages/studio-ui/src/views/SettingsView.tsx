import React from "react";
import { useStudioBrand } from "../context/StudioBrandContext.js";
import { ExtensionSlot } from "../context/StudioExtensionSlots.js";

export interface SettingsViewProps {
  creatorId: string;
  operatorEmail?: string;
  instanceVersion?: string;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  creatorId,
  operatorEmail,
  instanceVersion = "0.1.0",
}) => {
  const brand = useStudioBrand();

  return (
    <div className="ubeeq-studio-settings-view">
      <header className="ubeeq-studio-view-header">
        <div>
          <h1>Instance Settings</h1>
          <p>
            Configure runtime preferences and account settings for {brand.studioName}.
          </p>
        </div>
      </header>

      {/* Extension Slot: creatorSettingsTabsSlot */}
      <ExtensionSlot
        name="creatorSettingsTabsSlot"
        props={{ creatorId }}
      />

      <div className="ubeeq-settings-layout">
        <section className="ubeeq-settings-card">
          <h2>Operating Mode</h2>
          <div className="ubeeq-settings-row">
            <span>Architecture:</span>
            <strong>Self-Hosted Single-Operator Open-Core</strong>
          </div>
          <div className="ubeeq-settings-row">
            <span>Operator Identity:</span>
            <code>{operatorEmail || "Primary Operator"}</code>
          </div>
          <div className="ubeeq-settings-row">
            <span>Version:</span>
            <span>{instanceVersion}</span>
          </div>
          <p className="ubeeq-settings-note">
            In single-operator mode, {brand.studioName} manages personal collections,
            portfolio websites, and distribution channels without multi-user SaaS
            organization fees.
          </p>
        </section>

        {/* Extension Slot: accountBillingPanelSlot (Commercial SaaS billing, plans, top-up add-ons) */}
        <ExtensionSlot
          name="accountBillingPanelSlot"
          props={{ creatorId }}
        />
      </div>
    </div>
  );
};
