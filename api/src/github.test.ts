import { describe, expect, it } from "vitest";
import { githubConfiguration, githubFailureState } from "./github.js";

const privateKey =
  "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";

describe("GitHub App configuration", () => {
  it("accepts positive numeric identifiers and a PEM private key", () => {
    expect(
      githubConfiguration({
        GITHUB_APP_ENABLED: "true",
        GITHUB_APP_ID: "123",
        GITHUB_APP_INSTALLATION_ID: "456",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }),
    ).toEqual({ appId: "123", installationId: "456", privateKey });
  });

  describe("GitHub rate-limit observations", () => {
    it("recognizes primary/secondary 403 rate limits separately from missing installation access", () => {
      expect(githubFailureState({ status: 429 })).toBe("rate-limited");
      expect(githubFailureState({ status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } })).toBe("rate-limited");
      expect(githubFailureState({ status: 403, response: { headers: { "retry-after": "60" } } })).toBe("rate-limited");
      expect(githubFailureState({ status: 403 })).toBe("access-needed");
      expect(githubFailureState(new Error("timeout"))).toBe("unavailable");
    });
  });

  it("fails closed for malformed or unresolved configuration", () => {
    expect(githubConfiguration({ GITHUB_APP_ENABLED: "false" })).toBeNull();
    expect(
      githubConfiguration({
        GITHUB_APP_ENABLED: "true",
        GITHUB_APP_ID: "123",
        GITHUB_APP_INSTALLATION_ID: "not-a-number",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }),
    ).toBeNull();
    expect(
      githubConfiguration({
        GITHUB_APP_ENABLED: "true",
        GITHUB_APP_ID: "123",
        GITHUB_APP_INSTALLATION_ID: "456",
        GITHUB_APP_PRIVATE_KEY: "@Microsoft.KeyVault(SecretUri=unresolved)",
      }),
    ).toBeNull();
  });
});
