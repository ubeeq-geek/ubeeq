import { type ExtensionContract, type ExtensionManifest, validateExtensionManifest } from "@ubeeq/extension-sdk";

export const validateProductExtensions = (
  extensions: readonly ExtensionManifest[],
  requirements: Readonly<Record<string, readonly ExtensionContract[]>>
): void => {
  for (const [extensionId, requiredContracts] of Object.entries(requirements)) {
    const extension = extensions.find(({ id }) => id === extensionId);
    if (!extension) throw new Error(`Required extension ${extensionId} is not installed`);
    validateExtensionManifest(extension, requiredContracts);
  }
};

