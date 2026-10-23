import type { HttpRequest } from "@azure/functions";
import { isRecord, workforceConfiguration } from "./runtime.js";

export interface ClientPrincipal {
  identityProvider: string;
  userId: string;
  userDetails: string;
  userRoles: string[];
}

export function readClientPrincipal(request: HttpRequest): ClientPrincipal | null {
  const header = request.headers.get("x-ms-client-principal");
  if (!header) return null;

  try {
    if (header.length > 16384) return null;
    const value: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (!isRecord(value) || typeof value.identityProvider !== "string"
      || typeof value.userId !== "string"
      || typeof value.userDetails !== "string"
      || !Array.isArray(value.userRoles)
      || !value.userRoles.every((role) => typeof role === "string")) {
      return null;
    }
    return {
      identityProvider: value.identityProvider, userId: value.userId,
      userDetails: value.userDetails, userRoles: value.userRoles,
    };
  } catch {
    return null;
  }
}

export type PortalRole = "reader" | "operator" | "admin";

export function sharedRole(request: HttpRequest): PortalRole | null {
  if (!workforceConfiguration()) return null;
  const principal = readClientPrincipal(request);
  if (principal?.identityProvider !== "aad" || !principal.userRoles.includes("authenticated")) return null;
  if (principal.userRoles.includes("admin")) return "admin";
  if (principal.userRoles.includes("operator")) return "operator";
  return principal.userRoles.includes("reader") ? "reader" : null;
}

export function workforceRoles(payload: unknown): PortalRole[] {
  const configuration = workforceConfiguration();
  if (!configuration || !isRecord(payload) || payload.identityProvider !== "aad"
    || !Array.isArray(payload.claims) || payload.claims.length > 128) return [];
  const claims = payload.claims;
  const values = (names: string[]) => claims.flatMap((claim: unknown) =>
    isRecord(claim) && typeof claim.typ === "string" && names.includes(claim.typ) && typeof claim.val === "string"
      ? [claim.val] : [],
  );
  const tenants = values(["tid", "http://schemas.microsoft.com/identity/claims/tenantid"]);
  const issuers = values(["iss"]);
  const audiences = values(["aud"]);
  // SWA validates issuer/audience at login; its documented rolesSource payload can omit these JWT fields.
  if (tenants.length === 0 || tenants.some((tenant) => tenant.toLowerCase() !== configuration.tenantId.toLowerCase())
    || issuers.some((issuer) => issuer !== `https://login.microsoftonline.com/${configuration.tenantId}/v2.0`)
    || audiences.some((audience) => audience !== configuration.clientId)) return [];
  const roles = values(["roles", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"]);
  if (roles.includes("PawPrint.Admin")) return ["reader", "operator", "admin"];
  if (roles.includes("PawPrint.Operator")) return ["reader", "operator"];
  return roles.includes("PawPrint.Reader") ? ["reader"] : [];
}

export function requireAdmin(request: HttpRequest): ClientPrincipal | null {
  const principal = readClientPrincipal(request);
  return principal?.userRoles.some((role) => role.toLowerCase() === "admin") ? principal : null;
}