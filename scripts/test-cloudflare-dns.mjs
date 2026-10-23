import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDomainInZone, azureDnsRecords, createCloudflareClient, main,
  reconcileAzureDns, reconcileRecords, validateDomain, validateRecordManifest, verifyAzureDns,
} from "./cloudflare-dns.mjs";

const settings = {
  service: "app-service", owner: "ninjapaw/pawton:dev",
  domain: "pawton.example.org", azureHostname: "pawton-dev.azurewebsites.net",
  verificationId: "A".repeat(64), zoneId: "b".repeat(32), zoneName: "example.org",
  token: "test-token-not-to-log",
};
const comment = `pawprint:dns:${settings.owner}`;

function cloudflare(initial = [], options = {}) {
  const records = structuredClone(initial);
  const writes = [];
  const calls = [];
  let sequence = 0;
  for (const record of records) record.id ??= (++sequence).toString(16).padStart(32, "0");
  const zone = { id: settings.zoneId, name: "example.org", status: "active", ...options.zone };
  const fetcher = async (url, request) => {
    calls.push({ url, request });
    assert.equal(new URL(url).origin, "https://api.cloudflare.com");
    assert.equal(request.headers.Authorization, `Bearer ${settings.token}`);
    assert.equal(request.redirect, "error");
    assert.ok(request.signal instanceof AbortSignal);
    let result;
    if (!url.includes("/dns_records")) result = new URL(url).pathname.endsWith("/zones") ? [zone] : zone;
    else if (["POST", "PATCH"].includes(request.method)) {
      const body = JSON.parse(request.body);
      assert.ok(!request.body.includes(settings.token));
      writes.push({ method: request.method, body });
      if (request.method === "POST") {
        result = { ...body, id: (++sequence).toString(16).padStart(32, "0") };
        if (!options.dropWrites) records.push(result);
      } else {
        result = records.find((entry) => url.endsWith(`/${entry.id}`));
        Object.assign(result, body);
      }
    } else {
      result = records.filter((record) => record.name === new URL(url).searchParams.get("name"));
    }
    return Response.json({ success: true, result, result_info: { total_pages: options.pages ?? 1 } });
  };
  return { records, writes, calls, fetcher };
}

test("Azure record intents cover App Service, Static Web Apps, and Front Door without proxying", () => {
  for (const [service, azureHostname, prefix] of [
    ["app-service", "app.azurewebsites.net", "asuid"],
    ["static-web-app", "site.3.azurestaticapps.net", "_dnsauth"],
    ["front-door", "edge-hash.z01.azurefd.net", "_dnsauth"],
  ]) {
    const records = azureDnsRecords({ ...settings, service, azureHostname });
    assert.equal(records[0].name, `${prefix}.${settings.domain}`);
    assert.equal(records[1].content, azureHostname);
    assert.equal(records[1].proxied, false);
    assert.equal(records[1].settings.flatten_cname, false);
  }
  assert.equal(validateDomain("Pawton.Example.org"), settings.domain);
  for (const domain of ["", "*.example.org", "https://example.org", "a.example.org:443", "a.example.org/path", "a_1.example.org", "a".repeat(64) + ".org"]) {
    assert.throws(() => validateDomain(domain));
  }
  assert.throws(() => azureDnsRecords({ ...settings, azureHostname: "attacker.example.org" }));
  assert.throws(() => azureDnsRecords({ ...settings, verificationId: "" }));
  assert.equal(azureDnsRecords({
    ...settings, service: "front-door", azureHostname: "edge.azurefd.net", verificationId: "validation+/=token",
  })[0].content, "validation+/=token");
  assert.throws(() => azureDnsRecords({
    ...settings, service: "front-door", azureHostname: "edge.azurefd.net", verificationId: "invalid\nvalue",
  }));
  assert.throws(() => azureDnsRecords({ ...settings, service: "__proto__" }));
});

test("plan is read-only, apply reads back ownership, and repeat apply is a no-op", async () => {
  const mock = cloudflare();
  assert.deepEqual((await reconcileAzureDns(settings, mock)).map((entry) => entry.action), ["would create", "would create"]);
  assert.equal(mock.writes.length, 0);
  assert.deepEqual((await reconcileAzureDns(settings, { ...mock, apply: true })).map((entry) => entry.action), ["created", "created"]);
  assert.ok(mock.records.every((record) => record.comment === comment));
  assert.deepEqual((await reconcileAzureDns(settings, { ...mock, apply: true })).map((entry) => entry.action), ["found", "found"]);
  assert.deepEqual((await reconcileAzureDns({ ...settings, owner: "NinjaPaw/Pawton:DEV" },
    { ...mock, apply: true })).map((entry) => entry.action), ["found", "found"]);
  assert.equal(mock.writes.length, 2);
});

test("all names are inspected before any write; duplicate, foreign, or conflicting records fail closed", async () => {
  const [txt, cname] = azureDnsRecords(settings);
  for (const initial of [
    [{ ...cname, content: "other.azurewebsites.net" }],
    [{ ...cname, proxied: true }],
    [{ ...cname, settings: { flatten_cname: true } }],
    [{ ...cname, type: "A", content: "192.0.2.10" }],
    [{ ...txt, content: "wrong", comment: "pawprint:dns:ninjapaw/another:dev" }],
    [txt, txt],
  ]) {
    const mock = cloudflare(initial);
    await assert.rejects(reconcileAzureDns(settings, { ...mock, apply: true }), /Conflicting DNS|Ambiguous DNS/);
    assert.equal(mock.writes.length, 0);
  }
});

test("equivalent legacy records retain comments and TTL; only this exact owner may update", async () => {
  const [txt, cname] = azureDnsRecords(settings);
  const legacy = cloudflare([
    { ...txt, content: `"${txt.content}"`, ttl: 600, comment: "Managed by ninjapaw/pawprint" },
    { ...cname, content: cname.content.toUpperCase() + ".", ttl: 900 },
  ]);
  await reconcileAzureDns(settings, { ...legacy, apply: true });
  assert.equal(legacy.writes.length, 0);
  assert.equal(legacy.records[0].ttl, 600);
  const owned = cloudflare([{ ...txt, comment }, { ...cname, comment, content: "old.azurewebsites.net" }]);
  assert.deepEqual((await reconcileAzureDns(settings, owned)).map((entry) => entry.action), ["found", "would update"]);
  await reconcileAzureDns(settings, { ...owned, apply: true });
  assert.equal(owned.writes.length, 1);
  assert.equal(owned.writes[0].method, "PATCH");
  assert.equal(owned.records[1].content, cname.content);
});

test("zone ID and name must agree, and non-SWA Azure services reject apex domains", async () => {
  for (const zone of [
    { name: "another.org" }, { status: "pending" }, { id: "c".repeat(32) },
  ]) {
    const mock = cloudflare([], { zone });
    await assert.rejects(reconcileAzureDns(settings, { ...mock, apply: true }), /selected active Cloudflare zone/);
    assert.equal(mock.writes.length, 0);
  }
  assert.throws(() => assertDomainInZone("example.org", { name: "example.org" }), /apex/);
  assert.doesNotThrow(() => assertDomainInZone("example.org", { name: "example.org" }, { allowApex: true }));
  const byName = cloudflare();
  await reconcileAzureDns({ ...settings, zoneId: undefined }, byName);
  assert.ok(byName.calls[0].url.includes("/zones?name=example.org"));
});

test("pagination, concurrent edits, and missing readback never report success", async () => {
  for (const pages of [2, "invalid", -1]) {
    const paged = cloudflare([], { pages });
    await assert.rejects(reconcileAzureDns(settings, { ...paged, apply: true }), /Ambiguous DNS/);
    assert.equal(paged.writes.length, 0);
  }
  const missing = cloudflare([], { dropWrites: true });
  await assert.rejects(reconcileAzureDns(settings, { ...missing, apply: true }), /read back/);
  const [txt, cname] = azureDnsRecords(settings);
  const racing = cloudflare([{ ...txt, comment, content: "old" }, { ...cname, comment }]);
  let reads = 0;
  const fetcher = async (url, options) => {
    if (new URL(url).searchParams.get("name") === txt.name && ++reads === 2) racing.records[0].content = "concurrent";
    return racing.fetcher(url, options);
  };
  await assert.rejects(reconcileAzureDns(settings, { fetcher, apply: true }), /changed during reconciliation/);
  assert.equal(racing.writes.length, 0);
});

test("provider-normalized IPv6 and quoted TXT remain idempotent without accepting incomplete quotes", async () => {
  const manifest = validateRecordManifest({
    owner: "ninjapaw/pawprint:shared", zoneName: "example.org",
    records: [{ type: "AAAA", name: "status.example.org", content: "2001:0db8:0000:0000:0000:0000:0000:0001" }],
  });
  assert.equal(manifest.records[0].content, "2001:db8::1");
  const mock = cloudflare([{ type: "AAAA", name: "status.example.org", content: "2001:db8::1", proxied: false, ttl: 900 }]);
  const actions = await reconcileRecords({ ...settings, ...manifest }, { ...mock, apply: true });
  assert.equal(actions[0].action, "found");
  assert.equal(mock.writes.length, 0);
  const [txt] = azureDnsRecords(settings);
  await assert.rejects(reconcileAzureDns(settings, cloudflare([{ ...txt, content: `"${txt.content}` }])), /Conflicting DNS/);
});

test("Static Web Apps apex reconciliation preserves Azure authority, while offline validation needs no credential", async () => {
  const mock = cloudflare();
  const apex = { ...settings, service: "static-web-app", domain: "example.org", azureHostname: "site.azurestaticapps.net" };
  await reconcileAzureDns(apex, { ...mock, apply: true });
  assert.equal(mock.writes.length, 2);
  assert.equal(mock.records[1].name, "example.org");
  assert.equal(mock.records[1].proxied, false);
  await main(["validate"], {
    PAWPRINT_DNS_SERVICE: settings.service, PAWPRINT_DNS_OWNER: settings.owner,
    AZURE_CUSTOM_DOMAIN: settings.domain, AZURE_DEFAULT_HOSTNAME: settings.azureHostname,
    AZURE_DOMAIN_VALIDATION_TOKEN: settings.verificationId,
  });
});

test("Cloudflare errors omit upstream bodies, credentials, and network exception details", async () => {
  for (const fetcher of [
    async () => { throw new Error(settings.token); },
    async () => Response.json({ success: false, errors: [{ message: settings.token }] }, { status: 403 }),
    async () => new Response(settings.token, { status: 502 }),
  ]) {
    await assert.rejects(reconcileAzureDns(settings, { fetcher }), (error) => !error.message.includes(settings.token));
  }
  assert.throws(() => createCloudflareClient({ ...settings, token: "" }), /CLOUDFLARE_API_TOKEN/);
  assert.throws(() => createCloudflareClient({ ...settings, zoneId: "bad" }), /CLOUDFLARE_ZONE_ID/);
});

test("public DNS needs both direct Azure CNAME and matching TXT; SWA apex verifies TXT separately", async () => {
  await verifyAzureDns(settings, {
    resolveCname: async () => [settings.azureHostname + "."],
    resolveTxt: async () => [["A".repeat(32), "A".repeat(32)]],
  });
  for (const resolver of [
    { resolveTxt: async () => [["wrong"]], resolveCname: async () => [settings.azureHostname] },
    { resolveTxt: async () => [[settings.verificationId]], resolveCname: async () => ["proxy.example.org"] },
    { resolveTxt: async () => { throw new Error("ENODATA"); } },
  ]) await assert.rejects(verifyAzureDns(settings, resolver), /Public DNS is not ready/);
  await verifyAzureDns({ ...settings, service: "static-web-app", domain: "example.org", azureHostname: "site.azurestaticapps.net" }, {
    resolveTxt: async () => [[settings.verificationId]],
    resolveCname: async () => { throw new Error("Apex CNAMEs are flattened."); },
  });
});

test("shared records use the same ownership contract without accepting credentials or crossing zones", async () => {
  const manifest = {
    owner: "ninjapaw/pawprint:shared", zoneName: "example.org",
    records: [{ type: "CNAME", name: "status.example.org", content: "status.azurestaticapps.net" }],
  };
  const valid = validateRecordManifest(manifest);
  assert.equal(valid.records[0].proxied, false);
  const mock = cloudflare();
  await reconcileRecords({ ...valid, zoneId: settings.zoneId, token: settings.token }, { ...mock, apply: true });
  assert.equal(mock.records[0].comment, "pawprint:dns:ninjapaw/pawprint:shared");
  for (const patch of [
    { token: "secret" }, { owner: "implicit" }, { zoneName: "another.org" },
    { records: [...manifest.records, ...manifest.records] },
    { records: [{ ...manifest.records[0], proxied: true }] },
    { records: [{ type: "A", name: "status.example.org", content: "invalid" }] },
  ]) assert.throws(() => validateRecordManifest({ ...manifest, ...patch }));
  assert.deepEqual(await reconcileRecords({ ...manifest, records: [] }), []);
  await assert.rejects(main(["apply"], {}), /--yes/);
});
