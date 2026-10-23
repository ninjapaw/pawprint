import { app } from "@azure/functions";
import { adminStatus, dispatch, health } from "./handlers.js";
import { rolesSource, sharedStatus, sharedPreview, sharedRequest, sharedRequestStatus } from "./shared-handlers.js";

app.http("health", { methods: ["GET"], authLevel: "anonymous", route: "health", handler: health });
app.http("admin-status", { methods: ["GET"], authLevel: "anonymous", route: "admin/status", handler: adminStatus });
app.http("dispatch", { methods: ["POST"], authLevel: "anonymous", route: "actions/dispatch", handler: dispatch });
app.http("shared-status", { methods: ["GET"], authLevel: "anonymous", route: "shared/status", handler: sharedStatus });
app.http("shared-roles", { methods: ["POST"], authLevel: "anonymous", route: "shared/roles", handler: rolesSource });
app.http("shared-preview", { methods: ["POST"], authLevel: "anonymous", route: "shared/preview", handler: sharedPreview });
app.http("shared-request", { methods: ["POST"], authLevel: "anonymous", route: "shared/requests", handler: sharedRequest });
app.http("shared-request-status", { methods: ["GET"], authLevel: "anonymous", route: "shared/requests/{requestId}", handler: sharedRequestStatus });