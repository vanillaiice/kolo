/** Run the server tests against a disposable PostgreSQL 18 container on a random loopback port. */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const name = `kolo-test-postgres-${randomUUID().slice(0, 8)}`;
let created = false;
let status = 1;
try {
  await execute("docker", ["run", "--rm", "--detach", "--name", name, "-p", "127.0.0.1::5432",
    "-e", "POSTGRES_USER=kolo", "-e", "POSTGRES_PASSWORD=kolo", "-e", "POSTGRES_DB=kolo", "postgres:18"]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    // The image restarts once after init; require the TCP listener, not the init socket.
    try { await execute("docker", ["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "kolo", "-d", "kolo"]); ready = true; break; }
    catch { await delay(500); }
  }
  if (!ready) throw new Error("disposable PostgreSQL did not become ready");
  const { stdout } = await execute("docker", ["port", name, "5432/tcp"]);
  const port = stdout.trim().split("\n")[0].split(":").pop();
  const url = `postgres://kolo:kolo@127.0.0.1:${port}/kolo`;
  status = await new Promise((resolve) => {
    spawn("npm", ["test", "-w", "@kolo/server"], { stdio: "inherit", env: { ...process.env, KOLO_TEST_DATABASE_URL: url } })
      .on("exit", (code) => resolve(code ?? 1));
  });
} finally {
  if (created) await execute("docker", ["rm", "--force", name]);
}
process.exit(status);
