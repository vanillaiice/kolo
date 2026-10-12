#!/usr/bin/env node
import { run } from "./cli.ts";
try { process.exitCode = await run(process.argv.slice(2)); }
catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  const message = code === "EEXIST" ? "Output already exists" : code === "ENOENT" ? "Input file or output directory does not exist" : error instanceof Error ? error.message : "Command failed";
  process.stderr.write(`kolo: ${message}\n`);
  process.exitCode = 2;
}
