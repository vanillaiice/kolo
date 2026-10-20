/** Ensure the shared draft exists, or publish it once all supported targets are uploaded. */
import { spawnSync } from "node:child_process";
import { releaseVersion, releaseTag, releaseNotes, missingAssets, prerelease } from "./release-info.mjs";

function gh(args, allowFailure = false) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr.trim());
  return result;
}

const command = process.argv[2];
if (!["ensure", "publish"].includes(command)) throw new Error("Usage: node scripts/release-github.mjs <ensure|publish>");
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== releaseTag) {
  throw new Error(`Release tag must be ${releaseTag}; got ${process.env.RELEASE_TAG}.`);
}

const view = gh(["release", "view", releaseTag, "--json", "isDraft,assets"], command === "ensure");
if (view.status !== 0) {
  // Only create on a confirmed missing release; authentication/network failures must surface.
  if (!/release not found/i.test(view.stderr)) throw new Error(view.stderr.trim());
  gh(["release", "create", releaseTag, "--draft", `--prerelease=${prerelease}`, "--verify-tag",
    "--title", `KOLO ${releaseVersion}`, "--notes", releaseNotes()]);
  process.stdout.write(`Created shared draft ${releaseTag}.\n`);
} else {
  const release = JSON.parse(view.stdout);
  if (!release.isDraft) {
    if (command === "ensure") throw new Error(`${releaseTag} is already published; refusing to change it.`);
    process.stdout.write(`${releaseTag} is already published.\n`);
  } else if (command === "publish") {
    const missing = missingAssets(release.assets);
    if (missing.length) {
      process.stdout.write(`${releaseTag} stays draft until these files are uploaded:\n${missing.join("\n")}\n`);
    } else {
      gh(["release", "edit", releaseTag, "--draft=false", `--prerelease=${prerelease}`, "--title", `KOLO ${releaseVersion}`, "--notes", releaseNotes()]);
      process.stdout.write(`Published ${releaseTag} with Windows, Linux and Android targets.\n`);
    }
  }
}
