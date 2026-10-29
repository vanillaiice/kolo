/**
 * Shorten the still stretches of a walkthrough recording (a phone driven over adb waits seconds between steps),
 * keeping a short pause everywhere and time to read after each caption, and shift the WebVTT captions to match.
 * Usage: node scripts/walkthrough-tighten.mjs <input.mp4> <output.mp4> [captions.vtt ...]  (captions are rewritten)
 * The Android recorder uses tighten() directly with its own caption times.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Seconds of stillness kept everywhere, and after a caption appears. */
const PAUSE = 0.7, READ = 3.2, HOLD = 2.5;

/** Still intervals [start, end] in seconds, from ffmpeg's freezedetect. */
function stillIntervals(input) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-i", input, "-vf", "freezedetect=n=-55dB:d=0.5", "-an", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 26 });
  const starts = [...result.stderr.matchAll(/freeze_start: ([\d.]+)/g)].map(m => Number(m[1]));
  const ends = [...result.stderr.matchAll(/freeze_end: ([\d.]+)/g)].map(m => Number(m[1]));
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input], { encoding: "utf8" }));
  return starts.map((start, i) => [start, ends[i] ?? duration]);
}

/**
 * Cut each still interval down to PAUSE seconds, or to READ seconds after a caption that appears in it.
 * Writes the output video and returns a function mapping an input time to the output time.
 * @param {string} input
 * @param {string} output
 * @param {number[]} moments caption (and poster) times in the input, in seconds
 * @param {string[]} encode ffmpeg output options
 */
export function tighten(input, output, moments, encode = ["-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"]) {
  const removed = [];
  for (const [start, end] of stillIntervals(input)) {
    let keep = PAUSE;
    for (const moment of moments) if (moment >= start - 0.5 && moment <= end + 0.5) keep = Math.max(keep, moment - start + READ);
    if (end - start > keep + 0.1) removed.push([start + keep, end]);
  }
  const work = mkdtempSync(join(tmpdir(), "kolo-tighten-")), script = join(work, "filter.txt");
  // One select per 25 cuts: a single expression with hundreds of terms is more than ffmpeg's parser accepts.
  const selects = [];
  for (let i = 0; i < removed.length; i += 25) selects.push(`select='not(${removed.slice(i, i + 25).map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`).join("+")})'`);
  // The last frame is held a moment so the closing caption can be read.
  writeFileSync(script, [...selects, "setpts=N/FRAME_RATE/TB", `tpad=stop_mode=clone:stop_duration=${HOLD}`].join(","));
  try { execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-filter_script:v", script, ...encode, output], { stdio: "inherit" }); }
  finally { rmSync(work, { recursive: true, force: true }); }
  return time => {
    let shift = 0;
    for (const [a, b] of removed) { if (time >= b) shift += b - a; else if (time > a) shift += time - a; }
    return Math.max(0, time - shift);
  };
}

/** WebVTT from caption start times: each lasts until the next one, at most nine seconds. */
export const captionFile = (cues, end) => `WEBVTT\n\n${cues.map(cue => ({ ...cue, at: Math.min(cue.at, end - HOLD) })).map((cue, i, all) => `${i + 1}\n${stamp(cue.at)} --> ${stamp(Math.min(all[i + 1]?.at ?? end, cue.at + 9, end))}\n${cue.text}\n`).join("\n")}`;

const seconds = stamp => { const [h, m, s] = stamp.split(":"); return Number(h) * 3600 + Number(m) * 60 + Number(s); };
const stamp = value => `${String(Math.floor(value / 3600)).padStart(2, "0")}:${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${(value % 60).toFixed(3).padStart(6, "0")}`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, output, ...captionFiles] = process.argv.slice(2);
  if (!input || !output) throw new Error("Usage: walkthrough-tighten.mjs <input.mp4> <output.mp4> [captions.vtt ...]");
  const files = captionFiles.map(path => ({ path, text: readFileSync(path, "utf8") }));
  const moments = [...new Set(files.flatMap(({ text }) => [...text.matchAll(/^([\d:.]+) -->/gm)].map(m => seconds(m[1]))))];
  const map = tighten(input, output, moments);
  const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", output], { encoding: "utf8" }));
  for (const { path, text } of files) {
    const starts = [...text.matchAll(/^([\d:.]+) --> .*\n(.+)$/gm)].map(m => ({ at: map(seconds(m[1])), text: m[2] }));
    writeFileSync(path, captionFile(starts, duration));
  }
  process.stdout.write(`${output}: ${duration.toFixed(0)} s\n`);
}
