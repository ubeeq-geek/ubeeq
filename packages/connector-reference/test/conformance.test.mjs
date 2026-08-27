import test from "node:test";
import { runIntegrationConformanceSuite } from "@ubeeq/integrations";
import { createReferenceConnectorConformance } from "../dist/index.js";
test("reference connector runs real stateful conformance scenarios", async () => { await runIntegrationConformanceSuite(createReferenceConnectorConformance()); });
