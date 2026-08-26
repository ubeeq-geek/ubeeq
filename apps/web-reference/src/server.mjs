import { createServer } from "node:http";
import { EXTENSION_API_VERSION, EXTENSION_CONTRACTS } from "@ubeeq/extension-sdk";

const sendJson = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
};

export const createReferenceApp = () => createServer((request, response) => {
  if (request.url === "/health") return sendJson(response, 200, { status: "ok" });
  if (request.url === "/extension-contracts") {
    return sendJson(response, 200, { apiVersion: EXTENSION_API_VERSION, contracts: EXTENSION_CONTRACTS });
  }
  return sendJson(response, 404, { error: "not_found" });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 4173);
  createReferenceApp().listen(port, "127.0.0.1", () => console.log(`Ubeeq reference app listening on http://127.0.0.1:${port}`));
}
