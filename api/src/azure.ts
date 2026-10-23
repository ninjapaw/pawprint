import { ManagedIdentityCredential } from "@azure/identity";

const credential = new ManagedIdentityCredential();
export { credential as managedIdentity };

export class SourceError extends Error {
  constructor(readonly state: "access-needed" | "rate-limited" | "unavailable", readonly status?: number) {
    super(state);
  }
}

export async function armJson(path: string): Promise<unknown> {
  if (!/^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[a-zA-Z0-9._()-]+(?:\/|$)/i.test(path)
    || path.includes("..") || path.includes("#") || path.includes("%") || !path.includes("?api-version=")) {
    throw new SourceError("unavailable");
  }
  try {
    const token = await credential.getToken("https://management.azure.com/.default", { abortSignal: AbortSignal.timeout(8000) });
    const result = await fetch(`https://management.azure.com${path}`, {
      headers: { Authorization: `Bearer ${token.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!result.ok) throw new SourceError(
      result.status === 401 || result.status === 403 ? "access-needed"
        : result.status === 429 ? "rate-limited" : "unavailable", result.status,
    );
    return await result.json();
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("unavailable");
  }
}
