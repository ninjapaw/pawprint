import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validatePortalHost(metadata, { subscriptionId, resourceGroupName, functionAppName, nodeVersion }) {
  if (typeof subscriptionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(subscriptionId)
    || typeof resourceGroupName !== "string" || !/^[a-z0-9._()-]{1,90}$/i.test(resourceGroupName) || resourceGroupName.endsWith(".")
    || typeof functionAppName !== "string" || !/^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/i.test(functionAppName)
    || typeof nodeVersion !== "string" || !/^v?[1-9][0-9]*\.[0-9]+\.[0-9]+$/.test(nodeVersion)) {
    throw new Error("Portal publication requires an explicit valid target and pinned Node version.");
  }
  const expectedId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Web/sites/${functionAppName}`;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || typeof metadata.id !== "string" || metadata.id.toLowerCase() !== expectedId.toLowerCase()) {
    throw new Error("Portal publication metadata does not match the explicitly selected Function resource.");
  }
  const major = nodeVersion.replace(/^v/, "").split(".")[0];
  if (metadata.runtimeName !== "node" || metadata.runtimeVersion !== major) {
    throw new Error(`Portal publication requires the Function host to run Node ${major}. Apply the reviewed portal IaC runtime upgrade before publishing API code.`);
  }
  const hostPattern = new RegExp(`^${functionAppName.toLowerCase()}(?:-[a-z0-9]+)?(?:\\.[a-z0-9]+-[0-9]{2})?\\.azurewebsites\\.net$`);
  if (typeof metadata.hostName !== "string" || !hostPattern.test(metadata.hostName.toLowerCase())) {
    throw new Error("Portal publication requires the selected Function's Azure-assigned public-cloud hostname.");
  }
  return { origin: `https://${metadata.hostName.toLowerCase()}`, nodeMajor: major };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Supply the selected Function metadata JSON report path.");
    let metadata;
    try { metadata = JSON.parse(readFileSync(process.argv[2], "utf8")); }
    catch { throw new Error("Function metadata is missing or invalid; contents were omitted."); }
    const result = validatePortalHost(metadata, {
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
      resourceGroupName: process.env.PORTAL_RESOURCE_GROUP,
      functionAppName: process.env.PORTAL_FUNCTION_APP,
      nodeVersion: readFileSync(new URL("../.node-version", import.meta.url), "utf8").trim(),
    });
    console.log(`origin=${result.origin}`);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
