import { app } from "@azure/functions";
import { adminStatus, dispatch, health } from "./handlers.js";

app.http("health", { methods: ["GET"], authLevel: "anonymous", route: "health", handler: health });
app.http("admin-status", { methods: ["GET"], authLevel: "anonymous", route: "admin/status", handler: adminStatus });
app.http("dispatch", { methods: ["POST"], authLevel: "anonymous", route: "actions/dispatch", handler: dispatch });