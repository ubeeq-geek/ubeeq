import { type ExtensionContract, type ExtensionManifest, validateExtensionManifest } from "@ubeeq/extension-sdk";
import type { IdentityAdapter } from "@ubeeq/auth";
import type { JobQueue } from "@ubeeq/jobs";
import type { UbeeqRepositories } from "@ubeeq/persistence";
import type { DeliveryAdapter, ObjectStorage } from "@ubeeq/storage";

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

export interface InstanceConfiguration {
  instanceId: string;
  publicBaseUrl: string;
  extensions: readonly ExtensionManifest[];
  requiredExtensions: Readonly<Record<string, readonly ExtensionContract[]>>;
  localAdapter?: {
    /** SQLite is the selected embedded reference implementation; this path is owned by adapters-local. */
    sqliteDatabasePath: string;
    storageDirectory: string;
  };
}

export interface DependencyDiagnostic {
  name: string;
  check(): Promise<{ status: "ok" | "degraded" | "failed"; detail?: string }>;
}

/** Explicit application composition; transports receive services, never construct provider clients. */
export interface ReferenceApplicationDependencies {
  identity: IdentityAdapter;
  repositories: UbeeqRepositories;
  objectStorage: ObjectStorage;
  delivery: DeliveryAdapter;
  jobs: JobQueue;
  diagnostics?: readonly DependencyDiagnostic[];
}

export const validateInstanceConfiguration = (configuration: InstanceConfiguration): void => {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(configuration.instanceId)) throw new Error("Instance id is invalid");
  let origin: URL;
  try { origin = new URL(configuration.publicBaseUrl); }
  catch { throw new Error("Public base URL must be an absolute URL"); }
  if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
    throw new Error("Public base URL must use HTTPS outside local development");
  }
  if (configuration.localAdapter && (!configuration.localAdapter.sqliteDatabasePath.trim() || !configuration.localAdapter.storageDirectory.trim())) {
    throw new Error("Local adapter configuration requires SQLite database and storage paths");
  }
  validateProductExtensions(configuration.extensions, configuration.requiredExtensions);
};

export const composeReferenceApplication = (
  configuration: InstanceConfiguration,
  dependencies: ReferenceApplicationDependencies
): { configuration: InstanceConfiguration; extensions: ReadonlyMap<string, ExtensionManifest>; dependencies: ReferenceApplicationDependencies } => {
  validateInstanceConfiguration(configuration);
  if (!dependencies.identity || !dependencies.repositories || !dependencies.objectStorage || !dependencies.delivery || !dependencies.jobs) {
    throw new Error("Reference application composition requires identity, repositories, storage, delivery, and jobs adapters");
  }
  return { configuration, extensions: loadProductExtensions(configuration.extensions, configuration.requiredExtensions), dependencies };
};
