import { createApplication } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const application = await createApplication(config);
await application.listen(config.port, config.host);
process.stdout.write(`KOLO server listening on ${config.host}:${config.port}\n`);
