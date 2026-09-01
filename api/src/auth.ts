import type { HttpRequest } from "@azure/functions";

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
    const value = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Partial<ClientPrincipal>;
    if (typeof value.identityProvider !== "string"
      || typeof value.userId !== "string"
      || typeof value.userDetails !== "string"
      || !Array.isArray(value.userRoles)
      || !value.userRoles.every((role) => typeof role === "string")) {
      return null;
    }
    return value as ClientPrincipal;
  } catch {
    return null;
  }
}

export function requireAdmin(request: HttpRequest): ClientPrincipal | null {
  const principal = readClientPrincipal(request);
  return principal?.userRoles.some((role) => role.toLowerCase() === "admin") ? principal : null;
}