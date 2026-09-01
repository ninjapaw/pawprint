import assert from "node:assert/strict";
import { githubEnvironmentSubject } from "./github-oidc-subject.mjs";

const subject = githubEnvironmentSubject({
  id: 1335890753,
  name: "m365profiles",
  owner: { id: 301718044, login: "ninjapaw" },
}, "dev");

assert.equal(
  subject,
  "repo:ninjapaw@301718044/m365profiles@1335890753:environment:dev",
);
assert.throws(
  () => githubEnvironmentSubject({ name: "missing-ids" }, "dev"),
  /repository IDs/,
);
process.stdout.write("ok    builds the ID-qualified GitHub OIDC environment subject\n");