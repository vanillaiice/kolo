import { createApplication } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const application = await createApplication(config);
await application.listen({ port: config.port, host: config.host });
process.stdout.write(`KOLO server listening on ${config.host}:${config.port}\n`);

// Stop accepting requests and release PostgreSQL connections on orchestrator shutdown.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => { void application.close().then(() => process.exit(0), () => process.exit(1)); });
}
