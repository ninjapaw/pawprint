import { describe, expect, it } from "vitest";
import { dispatch } from "./handlers.js";

const principal = Buffer.from(
  JSON.stringify({
    identityProvider: "github",
    userId: "123",
    userDetails: "operator",
    userRoles: ["authenticated", "admin"],
  }),
).toString("base64");

function request(headers: Record<string, string>) {
  return {
    headers: new Headers({ "x-ms-client-principal": principal, ...headers }),
    json: async () => ({ workload: "site", step: "application" }),
  } as never;
}

const context = { log() {}, error() {} } as never;

describe("hosted dispatch request validation", () => {
  it("rejects a missing or cross-site origin", async () => {
    process.env.PORTAL_ALLOWED_ORIGIN = "https://portal.example";
    await expect(
      dispatch(request({ "content-type": "application/json" }), context),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      dispatch(
        request({
          origin: "https://attacker.example",
          "content-type": "application/json",
        }),
        context,
      ),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("rejects non-JSON content before GitHub configuration is evaluated", async () => {
    process.env.PORTAL_ALLOWED_ORIGIN = "https://portal.example";
    await expect(
      dispatch(
        request({
          origin: "https://portal.example",
          "content-type": "text/plain",
        }),
        context,
      ),
    ).resolves.toMatchObject({ status: 415 });
  });
});
