import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validatePortalPreview(result, { subscriptionId, resourceGroupName }) {
  if (typeof subscriptionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(subscriptionId)
      || typeof resourceGroupName !== "string" || !/^[a-z0-9._()-]{1,90}$/i.test(resourceGroupName)
      || resourceGroupName.endsWith(".")) {
    throw new Error("Portal preview requires an explicit valid subscription and resource-group target.");
  }
  if (result?.status !== "Succeeded" || !Array.isArray(result.changes) || result.changes.length > 500) {
    throw new Error("Portal what-if must return a complete successful, bounded change list.");
  }
  const scope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`.toLowerCase();
  const changes = result.changes.map((change) => {
    if (!change || typeof change !== "object" || Array.isArray(change)
      || typeof change.resourceId !== "string" || !["Create", "Modify", "NoChange"].includes(change.changeType)) {
      throw new Error("Portal preview contains destructive, unsupported, or incomplete resource changes.");
    }
    const id = change.resourceId.toLowerCase();
    if (!(id === scope && change.changeType === "NoChange") && !id.startsWith(`${scope}/providers/`)) {
      throw new Error("Portal preview contains changes outside the explicitly selected resource group.");
    }
    if (/[%?#\\\u0000-\u001f\u007f]|(?:^|\/)\.\.?(?:\/|$)/.test(id)) {
      throw new Error("Portal preview returned an invalid resource identifier.");
    }
    if (id !== scope) {
      const segments = id.slice(`${scope}/providers/`.length).split("/");
      if (segments.length < 3 || segments.length % 2 !== 1
        || !/^[a-z0-9]+(?:\.[a-z0-9]+)+$/.test(segments[0])
        || segments.some((segment) => !/^[a-z0-9._()-]+$/.test(segment))) {
        throw new Error("Portal preview returned an invalid resource identifier.");
      }
    }
    return { resourceId: change.resourceId, changeType: change.changeType };
  });
  return {
    status: "Succeeded",
    changeCount: changes.length,
    changes,
    note: "Scope/type summary only. Resource payloads and app-setting values are intentionally not printed or published.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Supply the portal what-if JSON report path.");
    let result;
    try { result = JSON.parse(readFileSync(process.argv[2], "utf8")); }
    catch { throw new Error("Portal what-if report is missing or invalid; contents were omitted."); }
    console.log(JSON.stringify(validatePortalPreview(result, {
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      resourceGroupName: process.env.PORTAL_RESOURCE_GROUP,
    }), null, 2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
