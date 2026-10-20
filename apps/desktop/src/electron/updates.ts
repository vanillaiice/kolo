import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import type { Database } from "@kolo/core/data/database/driver";
import type { ReleaseNote, Result, UpdateStatus, UpdateView } from "../shared/service.js";

/** How this copy of KOLO was installed, which decides whether it can replace itself. */
export type InstallKind = "nsis" | "appimage" | "deb" | "portable" | "store" | "development" | "other";

/** Reads the install kind from the runtime: electron-builder's portable launcher and AppImage runtime set these variables. */
export function installKind(runtime: { readonly platform: string; readonly packaged: boolean; readonly windowsStore: boolean; readonly env: Readonly<Record<string, string | undefined>>; readonly packageType: string | undefined }): InstallKind {
  if (!runtime.packaged) return "development";
  if (runtime.platform === "win32") return runtime.windowsStore ? "store" : runtime.env["PORTABLE_EXECUTABLE_FILE"] !== undefined ? "portable" : "nsis";
  if (runtime.platform === "linux") return runtime.env["APPIMAGE"] !== undefined ? "appimage" : runtime.packageType === "deb" ? "deb" : "other";
  return "other";
}

function modeOf(kind: InstallKind): UpdateView["mode"] {
  return kind === "nsis" || kind === "appimage" || kind === "deb" ? "install" : kind === "portable" ? "notify" : "none";
}

/** The part of electron-updater's AppUpdater that KOLO drives; tests substitute a fake. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  fullChangelog: boolean;
  checkForUpdates(): Promise<{ readonly isUpdateAvailable: boolean; readonly updateInfo: { readonly version: string; readonly releaseNotes?: string | readonly { readonly version: string; readonly note: string | null }[] | null } } | null>;
  downloadUpdate(): Promise<unknown>;
  /** Starts the installer; false when it could not start. */
  install(isSilent: boolean, isForceRunAfter: boolean): boolean;
  on(event: "download-progress", listener: (progress: { readonly percent: number }) => void): unknown;
}

/**
 * Whether going from `current` to `next` is non-breaking under semver's caret rule (`^current`): the same major from
 * 1.0.0, the same minor before it, and never a pre-release.
 */
export function nonBreaking(current: string, next: string): boolean { return semver.satisfies(next, `^${current}`); }

/** A pre-release (`-beta.1`) is offered only to a copy that is itself on a pre-release. */
export function offered(current: string, next: string): boolean {
  return semver.valid(next) !== null && semver.gt(next, current) && (semver.prerelease(next) === null || semver.prerelease(current) !== null);
}

const MAX_NOTES = 20, MAX_NOTE_BYTES = 64 * 1024;
/** The notes electron-updater read from GitHub, newest first and bounded; a missing note is left out. */
export function releaseNotes(version: string, notes: string | readonly { readonly version: string; readonly note: string | null }[] | null | undefined): ReleaseNote[] {
  const list = typeof notes === "string" ? [{ version, note: notes }] : Array.isArray(notes) ? notes : [];
  return list.filter(item => typeof item.note === "string" && item.note.trim() !== "" && semver.valid(item.version) !== null)
    .map(item => ({ version: item.version, html: item.note!.slice(0, MAX_NOTE_BYTES) }))
    .sort((left, right) => semver.rcompare(left.version, right.version)).slice(0, MAX_NOTES);
}

const HOUR = 3_600_000;

/** What the main process provides to {@link DesktopUpdates}. */
export interface UpdateOptions {
  readonly kind: InstallKind;
  readonly currentVersion: string;
  /** The preference file. */
  readonly preferences: string;
  /** Loads electron-updater on first use, so boot and tests never touch it. */
  readonly updater: () => Promise<Updater>;
  readonly publish: (view: UpdateView) => void;
  /** Copies the open shop database before any install; a failure stops the install. */
  readonly safetyCopy: () => Promise<void>;
  /** Closes the shop and its database before the installer runs. */
  readonly beforeInstall: () => Promise<void>;
  /** Quits after a started install, or restarts the old version when the installer did not start. */
  readonly afterInstall: (started: boolean) => void;
  readonly now: () => string;
}

/**
 * Checks GitHub Releases for a newer KOLO and, as the person chooses, downloads and installs it. Before 1.0.0 every
 * release is a GitHub pre-release, so pre-releases are read but a `-beta` version is offered only to a beta copy; from
 * 1.0.0 only full releases are read. A found version is downloaded only on request, or in the background when automatic
 * updates are on and the version is non-breaking ({@link nonBreaking}). Every install first copies the shop database
 * (`safetyCopy`) and closes the shop (`beforeInstall`); the automatic install on close runs after the same copy and
 * KOLO's own shutdown, and is cancelled when the copy fails. The preference is a small file in user data, kept like the
 * other per-computer preferences when the computer is reset.
 */
export class DesktopUpdates {
  private current: UpdateStatus = { state: "idle" };
  private automaticEnabled: boolean;
  private updater: Updater | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readonly mode: UpdateView["mode"];
  private readonly options: UpdateOptions;

  constructor(options: UpdateOptions) {
    this.options = options;
    this.mode = modeOf(options.kind);
    this.automaticEnabled = readAutomatic(options.preferences);
  }

  /** The state shown to the renderer. */
  view(): UpdateView {
    return { currentVersion: this.options.currentVersion, mode: this.mode, automatic: this.automaticEnabled, installsOnClose: this.closeInstalls(), status: this.current };
  }

  /** Checks shortly after start, then every six hours while KOLO stays open. */
  start(first = 20_000, every = 6 * HOUR): void {
    if (this.mode === "none") return;
    this.timers.push(setTimeout(() => { void this.check(); }, first), setInterval(() => { void this.check(); }, every));
  }

  /** Stops the scheduled checks. */
  dispose(): void { for (const timer of this.timers) clearTimeout(timer); this.timers = []; }

  /** Looks for a newer version; a check already running, a download or a downloaded update is left as it is. */
  async check(): Promise<UpdateView> {
    if (this.mode === "none" || this.current.state === "checking" || this.current.state === "downloading" || this.current.state === "ready") return this.view();
    this.set({ state: "checking" });
    try {
      const updater = await this.load(), result = await updater.checkForUpdates(), current = this.options.currentVersion;
      if (result === null || !result.isUpdateAvailable || !offered(current, result.updateInfo.version)) this.set({ state: "current", checkedAt: this.options.now() });
      else {
        const version = result.updateInfo.version;
        this.set({ state: "available", version, notes: releaseNotes(version, result.updateInfo.releaseNotes), breaking: !nonBreaking(current, version) });
        if (this.downloadsAutomatically()) void this.download();
      }
    } catch { this.set({ state: "failed", step: "check" }); }
    return this.view();
  }

  /** Downloads the version the last check found. */
  async download(): Promise<UpdateView> {
    const found = this.current;
    if (this.mode !== "install" || found.state !== "available") return this.view();
    const { version, notes, breaking } = found;
    this.set({ state: "downloading", version, notes, breaking, percent: 0 });
    try {
      await (await this.load()).downloadUpdate();
      this.set({ state: "ready", version, notes, breaking });
    } catch { this.set({ state: "failed", step: "download" }); }
    return this.view();
  }

  /**
   * Copies the shop, closes it, starts the installer and quits. When the copy fails nothing is installed; when the
   * installer cannot start, KOLO restarts on its current version.
   */
  async install(): Promise<UpdateView> {
    if (this.current.state !== "ready" || this.updater === undefined) return this.view();
    try { await this.options.safetyCopy(); } catch { this.set({ state: "failed", step: "backup" }); return this.view(); }
    this.dispose();
    this.updater.autoInstallOnAppQuit = false;
    await this.options.beforeInstall();
    let started = false;
    try { started = this.updater.install(true, true); } catch { started = false; }
    if (!started) this.set({ state: "failed", step: "install" });
    this.options.afterInstall(started);
    return this.view();
  }

  /** Before KOLO closes: copies the shop when an update will install on close, or cancels that install if the copy fails. */
  async beforeQuit(): Promise<void> {
    if (this.updater === undefined || !this.updater.autoInstallOnAppQuit) return;
    try { await this.options.safetyCopy(); } catch { this.updater.autoInstallOnAppQuit = false; }
  }

  /** Saves the preference; turning it on downloads a non-breaking update that was already found. */
  setAutomatic(enabled: boolean): UpdateView {
    this.automaticEnabled = enabled;
    try { writeFileSync(this.options.preferences, JSON.stringify({ automatic: enabled }), { mode: 0o600 }); } catch { /* Kept for this session only. */ }
    if (this.downloadsAutomatically()) void this.download();
    this.publish();
    return this.view();
  }

  private downloadsAutomatically(): boolean { return this.automaticEnabled && this.mode === "install" && this.current.state === "available" && !this.current.breaking; }

  // A .deb installs through a password prompt, which must not appear while the computer shuts KOLO down.
  private closeInstalls(): boolean { return this.options.kind === "nsis" || this.options.kind === "appimage"; }

  private async load(): Promise<Updater> {
    if (this.updater !== undefined) return this.updater;
    const updater = await this.options.updater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.fullChangelog = true;
    updater.allowPrerelease = semver.lt(this.options.currentVersion, "1.0.0") || semver.prerelease(this.options.currentVersion) !== null;
    updater.on("download-progress", progress => {
      if (this.current.state === "downloading") this.set({ ...this.current, percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
    });
    this.updater = updater;
    return updater;
  }

  private set(status: UpdateStatus): void { this.current = status; this.publish(); }
  private publish(): void {
    // Only a downloaded non-breaking version installs on close, and only with automatic updates on.
    if (this.updater !== undefined) this.updater.autoInstallOnAppQuit = this.automaticEnabled && this.closeInstalls() && this.current.state === "ready" && !this.current.breaking;
    this.options.publish(this.view());
  }
}

/**
 * A consistent copy of the open shop database, taken before an update migrates it: `<version>-<time>.db` in `directory`
 * (private to this user), keeping the newest `keep`. It holds what the shop database holds and nothing more.
 */
export function writeSafetyCopy(database: Database, directory: string, version: string, now: Date, keep = 3): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${version}-${now.toISOString().replace(/[:.]/g, "-")}.db`);
  if (existsSync(file)) throw new Error("a safety copy with this name already exists");
  try { database.run("VACUUM INTO ?", [file]); }
  catch (error) { rmSync(file, { force: true }); throw error; }
  // Newest first by the time in the name: the version prefix does not sort (0.10.0 < 0.9.0 as text), and mtimes can tie.
  const stamp = (name: string): string | undefined => /-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.db$/.exec(name)?.[1];
  const copies = readdirSync(directory).filter(name => stamp(name) !== undefined).sort((left, right) => stamp(right)!.localeCompare(stamp(left)!));
  for (const old of copies.slice(keep)) rmSync(join(directory, old), { force: true });
  return file;
}

function readAutomatic(path: string): boolean {
  try { const value: unknown = JSON.parse(readFileSync(path, "utf8")); return typeof value === "object" && value !== null && (value as { automatic?: unknown }).automatic === true; }
  catch { return false; }
}

/** IPC handlers for the update bridge; like the shop handlers, untrusted senders and malformed arguments are refused. */
export function updateHandlers(updates: DesktopUpdates, trusted: (event: unknown) => boolean, openDownloads: () => Promise<void>): Readonly<Record<string, (event: unknown, ...args: unknown[]) => unknown>> {
  const refused = (code: "permission_denied" | "invalid_input"): Result<never> => ({ ok: false, error: { code } });
  const ok = <T>(value: T): Result<T> => ({ ok: true, value });
  const query = (operation: () => Promise<UpdateView | null> | UpdateView | null) => async (event: unknown, ...args: unknown[]): Promise<Result<UpdateView | null>> =>
    !trusted(event) ? refused("permission_denied") : args.length !== 0 ? refused("invalid_input") : ok(await operation());
  return {
    "kolo:update-state": query(() => updates.view()),
    "kolo:check-update": query(() => updates.check()),
    "kolo:download-update": query(() => updates.download()),
    "kolo:install-update": query(() => updates.install()),
    "kolo:open-downloads": query(async () => { await openDownloads(); return null; }),
    "kolo:automatic-updates": (event: unknown, ...args: unknown[]): Result<UpdateView> => {
      if (!trusted(event)) return refused("permission_denied");
      const input = args[0];
      if (args.length !== 1 || typeof input !== "object" || input === null || Object.keys(input).some(key => key !== "enabled") || typeof (input as { enabled?: unknown }).enabled !== "boolean") return refused("invalid_input");
      return ok(updates.setAutomatic((input as { enabled: boolean }).enabled));
    },
  };
}
