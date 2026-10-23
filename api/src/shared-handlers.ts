import type { HttpHandler, HttpRequest, HttpResponseInit } from "@azure/functions";
import { readClientPrincipal, sharedRole, workforceRoles } from "./auth.js";
import { backendTrust } from "./trust.js";
import { sharedOverview } from "./observations.js";
import { actionReadiness, sharedActions, operationStore, createPreview, confirmRequest, requestStatus, OperationError } from "./operations.js";
import { isEnvironment, isRecord, uuidPattern, workforceConfiguration } from "./runtime.js";

const response = (status: number, body: unknown): HttpResponseInit => ({
  status, jsonBody: body, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function access(request: HttpRequest) {
  const principal = readClientPrincipal(request);
  if (!principal) return { allowed: false as const, response: response(403, { error: "Sign in with an explicitly assigned workforce role." }) };
  if (!workforceConfiguration()) return { allowed: false as const, response: response(503, {
    state: "setup-required", error: "Shared services require staged single-tenant Entra setup. Legacy administration is unchanged.",
  }) };
  const role = sharedRole(request);
  if (!role) return { allowed: false as const, response: response(403, { error: "An assigned PawPrint workforce Reader, Operator or Admin role is required." }) };
  const trust = await backendTrust();
  if (trust.state !== "verified") return { allowed: false as const, response: response(503, { state: "setup-required", trust, error: trust.message }) };
  return { allowed: true as const, principal, role, trust };
}

async function body(request: HttpRequest): Promise<Record<string, unknown>> {
  const origin = process.env.PORTAL_ALLOWED_ORIGIN?.trim();
  if (!origin || request.headers.get("origin") !== origin) throw new OperationError(403, "The request origin is not allowed.");
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new OperationError(415, "Content-Type must be application/json.");
  const text = await request.text();
  if (text.length > 4096) throw new OperationError(413, "Request body is too large.");
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch { /* Return the same bounded validation error for invalid JSON. */ }
  throw new OperationError(400, "A JSON object is required.");
}
const failure = (error: unknown) => response(error instanceof OperationError ? error.status : 503, {
  state: "unavailable", error: error instanceof OperationError ? error.message : "The trusted source or durable operation store is unavailable. No automatic retry will be attempted.",
});

export const sharedStatus: HttpHandler = async (request) => {
  const granted = await access(request);
  if (!granted.allowed) return granted.response;
  const environment = request.query.get("environment") ?? "dev";
  if (!isEnvironment(environment)) return response(400, { error: "Unknown environment." });
  const services = await sharedOverview(environment);
  return response(200, {
    environment, observedAt: new Date().toISOString(), role: granted.role, trust: granted.trust, services,
    actions: sharedActions.map((action) => ({
      ...action,
      permitted: granted.role === "admin" || (granted.role === "operator" && action.role === "operator"),
    })),
    actionReadiness: actionReadiness(environment), refreshAfterSeconds: 60,
  });
};

export const rolesSource: HttpHandler = async (request) => {
  const trust = await backendTrust();
  if (trust.state !== "verified" || !workforceConfiguration()) return response(200, { roles: [] });
  try {
    const text = await request.text();
    if (text.length > 65536) return response(200, { roles: [] });
    return response(200, { roles: workforceRoles(JSON.parse(text)) });
  } catch {
    return response(200, { roles: [] });
  }
};

export const sharedPreview: HttpHandler = async (request, context) => {
  const granted = await access(request);
  if (!granted.allowed) return granted.response;
  if (granted.role === "reader") return response(403, { error: "Readers cannot create operation previews." });
  try {
    const value = await body(request);
    if (Object.keys(value).some((key) => !["actionId", "environment"].includes(key))
      || !isEnvironment(value.environment)) throw new OperationError(400, "Only fixed actionId and environment inputs are allowed.");
    const action = sharedActions.find((item) => item.id === value.actionId);
    if (!action) throw new OperationError(404, "Unknown shared action.");
    const store = operationStore();
    if (!store) throw new OperationError(503, "Durable operation storage is not configured. Use the protected workflow.");
    const preview = await createPreview(store, granted.principal, granted.role, action.id, value.environment);
    context.log(JSON.stringify({ event: "shared-easm-preview", requestId: preview.requestId, operation: action.id, environment: value.environment }));
    return response(201, preview);
  } catch (error) { return failure(error); }
};

export const sharedRequest: HttpHandler = async (request, context) => {
  const granted = await access(request);
  if (!granted.allowed) return granted.response;
  if (granted.role === "reader") return response(403, { error: "Readers cannot request workflows." });
  try {
    const value = await body(request);
    if (Object.keys(value).some((key) => !["requestId", "confirmProtectedConfiguration", "approveWrite", "approveDiscovery"].includes(key))
      || typeof value.requestId !== "string" || !uuidPattern.test(value.requestId)
      || typeof value.confirmProtectedConfiguration !== "boolean"
      || typeof value.approveWrite !== "boolean" || typeof value.approveDiscovery !== "boolean") throw new OperationError(400, "Invalid bounded confirmation.");
    const store = operationStore();
    if (!store) throw new OperationError(503, "Durable operation storage is not configured.");
    const result = await confirmRequest(store, granted.principal, granted.role, value.requestId, {
      confirmProtectedConfiguration: value.confirmProtectedConfiguration,
      approveWrite: value.approveWrite, approveDiscovery: value.approveDiscovery,
    });
    context.log(JSON.stringify({ event: "shared-easm-request", requestId: result.requestId, operation: result.actionId, environment: result.environment, state: result.state }));
    return response(result.state === "rejected" ? 502 : 202, result);
  } catch (error) { return failure(error); }
};

export const sharedRequestStatus: HttpHandler = async (request) => {
  const granted = await access(request);
  if (!granted.allowed) return granted.response;
  const id = request.params.requestId;
  if (!id || !uuidPattern.test(id)) return response(400, { error: "Invalid request ID." });
  try {
    const store = operationStore();
    if (!store) throw new OperationError(503, "Durable operation storage is not configured.");
    return response(200, await requestStatus(store, granted.principal, id));
  } catch (error) { return failure(error); }
};
