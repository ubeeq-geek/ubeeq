export interface DeploymentArtifact { path: string; fileCount: number; sha256: string; }
export interface DeploymentArtifactManifest { schemaVersion: 1; product: string; revision: string; artifacts: Readonly<Record<string, DeploymentArtifact>>; }
export interface RegionalDeploymentPlan { regions: readonly string[]; artifactRegistryStackName: string; }

export const validateDeploymentArtifactManifest = (manifest: DeploymentArtifactManifest, expected: { product: string; revision: string; artifacts: readonly string[] }): DeploymentArtifactManifest => {
  if (manifest.schemaVersion !== 1 || manifest.product !== expected.product || manifest.revision !== expected.revision) throw new Error("Deployment artifact manifest identity does not match the planned release");
  if (JSON.stringify(Object.keys(manifest.artifacts).sort()) !== JSON.stringify([...expected.artifacts].sort())) throw new Error("Deployment artifact manifest components do not match the planned release");
  for (const artifact of Object.values(manifest.artifacts)) {
    if (!artifact.path || !Number.isInteger(artifact.fileCount) || artifact.fileCount < 1 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("Deployment artifact manifest contains an invalid artifact");
  }
  return manifest;
};

export const validateRegionalDeploymentPlan = (plan: RegionalDeploymentPlan): RegionalDeploymentPlan => {
  if (!plan.artifactRegistryStackName.trim() || plan.regions.length === 0 || new Set(plan.regions).size !== plan.regions.length || plan.regions.some((region) => !/^[a-z]{2}-[a-z]+-\d$/.test(region))) throw new Error("Regional deployment plan is invalid");
  return plan;
};
