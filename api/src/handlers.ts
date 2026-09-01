import type { HttpHandler, HttpResponseInit } from "@azure/functions";
import { requireAdmin } from "./auth.js";
import { dispatchWorkflow, githubConfiguration } from "./github.js";
import { resolveWorkflow } from "./workloads.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const response = (status: number, body: unknown): HttpResponseInit => ({
  status,
  jsonBody: body,
  headers: jsonHeaders,
});

export const health: HttpHandler = async () =>
  response(200, {
    status: "ok",
  });

export const adminStatus: HttpHandler = async (request) => {
  const principal = requireAdmin(request);
  if (!principal)
    return response(403, { error: "The Pawprint admin role is required." });
  return response(200, {
    status: "ok",
    githubAppConfigured: githubConfiguration() !== null,
    identityProvider: principal.identityProvider,
    userDetails: principal.userDetails,
  });
};

export const dispatch: HttpHandler = async (request, context) => {
  const principal = requireAdmin(request);
  if (!principal)
    return response(403, { error: "The Pawprint admin role is required." });

  const allowedOrigin = process.env.PORTAL_ALLOWED_ORIGIN?.trim();
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (!allowedOrigin || request.headers.get("origin") !== allowedOrigin) {
    return response(403, { error: "The request origin is not allowed." });
  }
  if (contentType !== "application/json") {
    return response(415, { error: "Content-Type must be application/json." });
  }

  const configuration = githubConfiguration();
  if (!configuration) {
    return response(503, {
      error: "The dedicated Pawprint GitHub App is not configured.",
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return response(400, { error: "A JSON request body is required." });
  }
  if (!body || typeof body !== "object")
    return response(400, { error: "Invalid request body." });
  const { workload, step } = body as { workload?: unknown; step?: unknown };
  if (typeof workload !== "string" || typeof step !== "string") {
    return response(400, { error: "workload and step are required." });
  }

  const target = resolveWorkflow(workload, step);
  if (!target) return response(404, { error: "Unknown deployment action." });

  try {
    await dispatchWorkflow(
      configuration,
      target.repository,
      target.workflow.workflow,
      target.workflow.inputs,
    );
    context.log(
      `Hosted dispatch by ${principal.userDetails}: ${workload}/${step}`,
    );
    return response(202, {
      message: `Started ${workload} ${step} deployment in dev.`,
    });
  } catch (error) {
    context.error("GitHub workflow dispatch failed", error);
    return response(502, {
      error: "GitHub did not accept the workflow dispatch.",
    });
  }
};
