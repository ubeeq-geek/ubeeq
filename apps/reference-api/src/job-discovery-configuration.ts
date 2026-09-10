import type { AwsJobDiscoveryIndexes } from "@ubeeq/adapter-aws";

/** An operator assertion, not an automatic index or historical-data check. */
export const jobDiscoveryConfiguration = (environment: Readonly<Record<string, string | undefined>>): { jobDiscoveryIndexes?: AwsJobDiscoveryIndexes } => {
  const cellDue = environment.UBEEQ_JOB_CELL_DUE_INDEX;
  const cellTypeDue = environment.UBEEQ_JOB_CELL_TYPE_DUE_INDEX;
  const qualified = environment.UBEEQ_JOB_DISCOVERY_QUALIFIED;
  if (cellDue === undefined && cellTypeDue === undefined && qualified === undefined) return {};
  const validName = (value: string | undefined): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{3,255}$/.test(value);
  if (!validName(cellDue) || !validName(cellTypeDue) || cellDue === cellTypeDue || qualified !== "true") {
    throw new Error("Indexed job discovery requires distinct valid UBEEQ_JOB_CELL_DUE_INDEX and UBEEQ_JOB_CELL_TYPE_DUE_INDEX names and UBEEQ_JOB_DISCOVERY_QUALIFIED=true after table qualification.");
  }
  return { jobDiscoveryIndexes: { cellDue, cellTypeDue } };
};
