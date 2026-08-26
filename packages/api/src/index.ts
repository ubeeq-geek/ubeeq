import { type ExtensionContract, type ExtensionManifest, validateExtensionManifest } from "@ubeeq/extension-sdk";

export const validateProductExtensions = (
  extensions: readonly ExtensionManifest[],
  requirements: Readonly<Record<string, readonly ExtensionContract[]>>
): void => {
  const extensionIds = extensions.map(({ id }) => id);
  if (new Set(extensionIds).size !== extensionIds.length) throw new Error("Extension manifests must have unique ids");
  for (const [extensionId, requiredContracts] of Object.entries(requirements)) {
    const extension = extensions.find(({ id }) => id === extensionId);
    if (!extension) throw new Error(`Required extension ${extensionId} is not installed`);
    validateExtensionManifest(extension, requiredContracts);
  }
};

/** Loads a product's declared extension set only after all compatibility gates pass. */
export const loadProductExtensions = <TExtension extends ExtensionManifest>(
  extensions: readonly TExtension[],
  requirements: Readonly<Record<string, readonly ExtensionContract[]>>
): ReadonlyMap<string, TExtension> => {
  validateProductExtensions(extensions, requirements);
  return new Map(extensions.map((extension) => [extension.id, extension]));
};
