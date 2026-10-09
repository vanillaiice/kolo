/** Verify the built server image with a fresh, private PostgreSQL and no host ports. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const name = `kolo-foundation-${randomUUID().slice(0, 8)}`;
const postgres = `${name}-postgres`;
let networkCreated = false;
let postgresCreated = false;
try {
  await execute("docker", ["network", "create", name]); networkCreated = true;
  await execute("docker", ["run", "--rm", "--detach", "--name", postgres, "--network", name,
    "-e", "POSTGRES_USER=kolo", "-e", "POSTGRES_PASSWORD=kolo", "-e", "POSTGRES_DB=kolo", "postgres:18"]);
  postgresCreated = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { await execute("docker", ["exec", postgres, "pg_isready", "-U", "kolo", "-d", "kolo"]); ready = true; break; }
    catch { await delay(500); }
  }
  if (!ready) throw new Error("disposable PostgreSQL did not become ready");
  const { stdout, stderr } = await execute("docker", ["run", "--rm", "--network", name,
    "-e", `KOLO_TEST_DATABASE_URL=postgres://kolo:kolo@${postgres}:5432/kolo`,
    "kolo-server:foundation", "node", "--test", "apps/server/dist/app.test.js"], { timeout: 30000 });
  process.stdout.write(stdout); process.stderr.write(stderr);
} finally {
  if (postgresCreated) await execute("docker", ["rm", "--force", postgres]);
  if (networkCreated) await execute("docker", ["network", "rm", name]);
}
