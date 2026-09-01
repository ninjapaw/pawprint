import { describe, expect, it } from "vitest";
import { readClientPrincipal } from "./auth.js";

const request = (value?: unknown) => ({
  headers: new Headers(value === undefined ? {} : {
    "x-ms-client-principal": Buffer.from(JSON.stringify(value)).toString("base64"),
  }),
}) as never;

describe("Static Web Apps principal", () => {
  it("reads a valid principal", () => {
    expect(readClientPrincipal(request({
      identityProvider: "github",
      userId: "123",
      userDetails: "operator",
      userRoles: ["authenticated", "admin"],
    }))?.userRoles).toContain("admin");
  });

  it("fails closed for a malformed principal", () => {
    expect(readClientPrincipal(request({ userRoles: ["admin"] }))).toBeNull();
    expect(readClientPrincipal(request())).toBeNull();
  });
});