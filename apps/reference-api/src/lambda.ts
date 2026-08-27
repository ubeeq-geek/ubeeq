/** AWS deployment entry point; all provider SDK access remains in the AWS adapter package. */
import { createAwsReferenceHealthHandler } from "@ubeeq/adapters-aws";
const required = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is not configured`); return value; };
export const handler = createAwsReferenceHealthHandler({ region: process.env.AWS_REGION, recordsTable: () => required("UBEEQ_RECORDS_TABLE"), sourceBucket: () => required("UBEEQ_SOURCE_BUCKET"), jobsQueueUrl: () => required("UBEEQ_JOBS_QUEUE_URL") });
