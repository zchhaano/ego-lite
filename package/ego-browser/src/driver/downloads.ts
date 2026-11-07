import {
  type Dirent,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { runtimeStateDir } from "../env.js";

type DownloadServices = {
  cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<any>;
  subscribePageEvents(
    targetId: string,
    listener: (event: any) => void,
  ): () => void;
};

type DownloadCompletion = { path: string; failure: null } | { failure: string };

export type DownloadOptions = {
  timeoutMs: number;
  downloadTimeoutMs?: number;
  downloadIdleTimeoutMs?: number;
  maxDownloadBytes?: number;
};

export type DownloadArtifact = {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly finished: Promise<void>;
  saveAs(path: string): Promise<void>;
  path(): Promise<string>;
  failure(): Promise<string | null>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
};

export type DownloadInterception = {
  ready(sessionId: string): Promise<void>;
  event: Promise<DownloadArtifact>;
  dispose(reason?: Error): Promise<void>;
};

// Chromium keeps one download behavior per BrowserContext, and every ego lite
// TaskSpace shares one context, so Page.setDownloadBehavior from any Page, in
// any ego-browser process, overrides the others: the most recent call wins
// and "default" from one Page strips the directory from everyone. Downloads
// therefore all use the same directory with Chromium's `allowAndName`
// behavior, which names each file after its download guid. Re-applying the
// identical setting is harmless, and a waiter finds its own file by guid no
// matter which Page armed last. The behavior goes back to default only when
// no process on this machine still waits for a download.
const WAITERS_DIRECTORY = "waiters";
const STALE_WAITER_MS = 60 * 60 * 1_000;
const WAITER_REFRESH_MS = 10 * 60 * 1_000;
const STALE_FILE_MS = 24 * 60 * 60 * 1_000;
const FILE_POLL_INTERVAL_MS = 50;
const CLEANUP_TIMEOUT_MS = 1_000;

let sharedDirectory: string | undefined;
let waiterRefreshTimer: ReturnType<typeof setInterval> | undefined;
const ownedFiles = new Set<string>();
const armedInterceptions = new Set<symbol>();
const activeInterceptions = new Set<() => void>();
const activeDownloadTargets = new Set<string>();

/**
 * The directory every ego-browser process on this machine downloads into.
 * Files are named after their Chromium download guid.
 */
export function downloadDirectory(): string {
  if (sharedDirectory) return sharedDirectory;
  const directory = join(runtimeStateDir(), "downloads");
  mkdirSync(join(directory, WAITERS_DIRECTORY), { recursive: true });
  removeStaleFiles(directory);
  sharedDirectory = directory;
  return directory;
}

export function validateDownloadOptions(options: DownloadOptions): void {
  for (const key of [
    "timeoutMs",
    "downloadTimeoutMs",
    "downloadIdleTimeoutMs",
  ] as const) {
    const value = options[key];
    if (
      value !== undefined &&
      (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)
    ) {
      throw new TypeError(
        `${key} must be greater than 0 and at most 2147483647 milliseconds`,
      );
    }
  }
  if (
    options.maxDownloadBytes !== undefined &&
    (!Number.isSafeInteger(options.maxDownloadBytes) ||
      options.maxDownloadBytes <= 0)
  ) {
    throw new TypeError("maxDownloadBytes must be a positive safe integer");
  }
}

/**
 * Arm one Page session for its next download.
 */
export function preparePageDownload(
  services: DownloadServices,
  targetId: string,
  options: DownloadOptions,
): DownloadInterception {
  validateDownloadOptions(options);
  const {
    timeoutMs,
    downloadTimeoutMs = 120_000,
    downloadIdleTimeoutMs = 30_000,
    maxDownloadBytes = 100 * 1024 * 1024,
  } = options;
  if (activeDownloadTargets.has(targetId)) {
    throw new Error(`${targetId} is already waiting for a download`);
  }
  activeDownloadTargets.add(targetId);
  const token = Symbol(targetId);
  const configuredSessions = new Map<string, Promise<unknown>>();
  const guids = new Set<string>();
  let guid: string | undefined;
  let filePath: string | undefined;
  let settled = false;
  let terminalResult: DownloadCompletion | undefined;
  let finishing: Promise<unknown> | undefined;
  const cancellations = new Map<string, Promise<unknown>>();
  let contextInfo: Promise<any> | undefined;
  let filePollTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let receivedBytes = 0;
  let diskBytes = 0;
  let checking = false;
  let resolveEvent!: (artifact: DownloadArtifact) => void;
  let rejectEvent!: (error: Error) => void;
  let resolveCompletion!: (completion: DownloadCompletion) => void;
  const event = new Promise<DownloadArtifact>((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  void event.catch(() => {});
  const completion = new Promise<DownloadCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  // Decide synchronously whether this waiter was the last one, and send the
  // reset in the same tick, so a `ready()` that follows in this process always
  // sends its setting after the reset.
  const restoreBehavior = async (): Promise<(Error | undefined)[]> => {
    const sessions = [...configuredSessions.entries()];
    configuredSessions.clear();
    if (!releaseSharedBehavior(token)) return [];
    const restored: (string | undefined)[] = [];
    const errors: (Error | undefined)[] = [];
    await Promise.all(
      sessions.map(async ([sessionId, ready]) => {
        await bounded(ready).catch(() => {});
        try {
          await bounded(
            services.cdp(
              "Page.setDownloadBehavior",
              { behavior: "default" },
              sessionId,
              CLEANUP_TIMEOUT_MS,
            ),
          );
          restored.push(sessionId);
          errors.push(undefined);
        } catch (error) {
          restored.push(undefined);
          errors.push(asError(error));
        }
      }),
    );
    // Another process may have registered, and sent its setting, between the
    // marker check and Chromium applying the reset; its setting then lost.
    // The reset has been applied once its response is back, so a marker seen
    // now belongs to a waiter whose later sends land after it, and one seen
    // from before only needs the setting put back for it.
    const session = restored.find((sessionId) => sessionId !== undefined);
    if (session && armedInterceptions.size === 0 && hasOtherLiveWaiter()) {
      await bounded(
        services.cdp(
          "Page.setDownloadBehavior",
          { behavior: "allowAndName", downloadPath: downloadDirectory() },
          session,
          CLEANUP_TIMEOUT_MS,
        ),
      ).catch(() => {});
    }
    return errors;
  };

  const cancelNative = (downloadGuid: string) => {
    if (cancellations.has(downloadGuid)) return;
    const cancellation = (async () => {
      contextInfo ??= bounded(
        services.cdp(
          "Target.getTargetInfo",
          { targetId },
          undefined,
          CLEANUP_TIMEOUT_MS,
        ),
      );
      const targetInfo = await contextInfo;
      const browserContextId = targetInfo?.targetInfo?.browserContextId;
      await bounded(
        services.cdp(
          "Browser.cancelDownload",
          {
            guid: downloadGuid,
            ...(typeof browserContextId === "string"
              ? { browserContextId }
              : {}),
          },
          undefined,
          CLEANUP_TIMEOUT_MS,
        ),
      );
    })().catch((error) => error);
    cancellations.set(downloadGuid, cancellation);
  };

  const finish = (
    result: DownloadCompletion,
    cancel = false,
  ): Promise<unknown> => {
    if (finishing) return finishing;
    settled = true;
    terminalResult = result;
    clearTimeout(startTimer);
    clearTimeout(filePollTimer);
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
    activeInterceptions.delete(disposeSynchronously);
    if (cancel) {
      for (const downloadGuid of guids) cancelNative(downloadGuid);
    }
    // Start restoreBehavior synchronously so releaseSharedBehavior runs in the
    // caller's tick, while keeping the page listener subscribed until restore
    // finishes so any late GUID arriving during cleanup is canceled too.
    const restorePromise = restoreBehavior();
    finishing = (async () => {
      const restoreErrors = await restorePromise;
      unsubscribe();
      const cancellationErrors = await Promise.all(cancellations.values());
      result = terminalResult!;
      const restoreError = restoreErrors.find(Boolean);
      const cancellationError = cancellationErrors.find(Boolean);
      if (restoreError) {
        result = {
          failure: `${result.failure ? result.failure + "; " : ""}restoring Page download behavior failed: ${restoreError.message}`,
        };
      }
      if (cancellationError) {
        result = {
          failure: `${result.failure ? result.failure + "; " : ""}native cancellation failed: ${asError(cancellationError).message}`,
        };
      }
      if (result.failure !== null && filePath) {
        try {
          await removeOwnedFile(filePath);
        } catch (error) {
          result = {
            failure: `${result.failure}; cleanup failed: ${asError(error).message}`,
          };
        }
      }
      if (result.failure !== null) {
        rejectEvent(new Error(result.failure));
      }
      activeDownloadTargets.delete(targetId);
      resolveCompletion(result);
      return cancellationError ?? restoreError;
    })();
    return finishing;
  };

  const fail = (message: string) => {
    void finish({ failure: message }, true);
  };

  const refreshIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () =>
        fail(
          `download inactive for ${downloadIdleTimeoutMs}ms without progress`,
        ),
      downloadIdleTimeoutMs,
    );
  };

  const scheduleFileCheck = () => {
    if (settled || filePollTimer) return;
    filePollTimer = setTimeout(
      () => void checkForDownloadedFile(),
      FILE_POLL_INTERVAL_MS,
    );
  };

  // Chromium writes `<guid>.crdownload` and renames it to `<guid>` once the
  // download completes, so the final name appearing is the completion signal
  // even when the final progress event never arrives.
  const checkForDownloadedFile = async () => {
    filePollTimer = undefined;
    if (settled || !filePath || checking) return;
    checking = true;
    try {
      const result = await inspectDownloadFile(filePath, maxDownloadBytes);
      if (settled) return;
      if (result.bytes > diskBytes) {
        diskBytes = result.bytes;
        refreshIdle();
      }
      if (result.path) {
        await finish({ path: result.path, failure: null });
        return;
      }
    } catch (error) {
      if (!settled) fail(asError(error).message);
    } finally {
      checking = false;
      scheduleFileCheck();
    }
  };

  const onEvent = (message: any) => {
    const params = message?.params;
    if (message?.method === "Page.downloadWillBegin") {
      if (
        typeof params?.guid !== "string" ||
        !params.guid ||
        typeof params?.url !== "string" ||
        typeof params?.suggestedFilename !== "string"
      ) {
        return;
      }
      guids.add(params.guid);
      if (settled) {
        if (guid !== params.guid) {
          terminalResult = {
            failure:
              "multiple downloads started in one Page; artifact ownership is ambiguous",
          };
          cancelNative(params.guid);
        }
        return;
      }
      if (guid) {
        if (guid !== params.guid) {
          fail(
            "multiple downloads started in one Page; artifact ownership is ambiguous",
          );
        }
        return;
      }
      guid = params.guid;
      clearTimeout(startTimer);
      if (
        !isSafeFilename(params.guid) ||
        !isSafeFilename(params.suggestedFilename)
      ) {
        fail("download has an unsafe or unsupported suggested filename");
        return;
      }
      filePath = join(downloadDirectory(), params.guid);
      ownedFiles.add(filePath);
      resolveEvent(
        new PageDownloadArtifact(
          params.url,
          params.suggestedFilename,
          filePath,
          completion,
          async () => {
            if (settled) {
              await finishing;
              return;
            }
            const error = await finish({ failure: "canceled" }, true);
            if (error) throw error;
          },
        ),
      );
      totalTimer = setTimeout(
        () => fail(`download timed out after ${downloadTimeoutMs}ms`),
        downloadTimeoutMs,
      );
      refreshIdle();
      scheduleFileCheck();
      return;
    }
    if (
      settled ||
      message?.method !== "Page.downloadProgress" ||
      !guid ||
      params?.guid !== guid
    ) {
      return;
    }
    if (
      params.receivedBytes > maxDownloadBytes ||
      params.totalBytes > maxDownloadBytes
    ) {
      fail(`download exceeds maxDownloadBytes (${maxDownloadBytes} bytes)`);
      return;
    }
    if (
      Number.isFinite(params.receivedBytes) &&
      params.receivedBytes > receivedBytes
    ) {
      receivedBytes = params.receivedBytes;
      refreshIdle();
    }
    if (params.state === "completed") {
      clearTimeout(filePollTimer);
      filePollTimer = undefined;
      void checkForDownloadedFile();
    } else if (params.state === "canceled") {
      void finish({ failure: "canceled" });
    }
  };

  const unsubscribe = services.subscribePageEvents(targetId, onEvent);
  const disposeSynchronously = () => {
    void finish({ failure: "download waiter was disposed" }, true);
  };
  activeInterceptions.add(disposeSynchronously);
  const startTimer = setTimeout(
    () => fail(`page.waitForEvent("download") timed out after ${timeoutMs}ms`),
    timeoutMs,
  );

  return {
    async ready(sessionId: string) {
      if (settled) {
        throw new Error("download waiter is no longer active");
      }
      const downloadPath = downloadDirectory();
      // Register the session before sending: a rejected call (a timeout, say)
      // may still have been applied, and the restore must reach that session.
      claimSharedBehavior(token);
      const ready = services.cdp(
        "Page.setDownloadBehavior",
        { behavior: "allowAndName", downloadPath },
        sessionId,
      );
      void ready.catch(() => {});
      configuredSessions.set(sessionId, ready);
      await bounded(ready, timeoutMs);
      if (settled) {
        throw new Error("download waiter is no longer active");
      }
    },
    event,
    async dispose(reason = new Error("download waiter was disposed")) {
      await finish({ failure: reason.message }, true);
    },
  };
}

class PageDownloadArtifact implements DownloadArtifact {
  readonly finished: Promise<void>;

  constructor(
    readonly url: string,
    readonly suggestedFilename: string,
    private readonly filePath: string,
    private readonly completion: Promise<DownloadCompletion>,
    private readonly cancelDownload: () => Promise<void>,
  ) {
    this.finished = completion.then(() => {});
  }

  async saveAs(path: string): Promise<void> {
    assertAbsolutePath(path, "download.saveAs");
    const sourcePath = await this.path();
    await mkdir(dirname(path), { recursive: true });
    await copyFile(sourcePath, path);
  }

  async path(): Promise<string> {
    const result = await this.completion;
    if (!("path" in result)) {
      throw new Error(`download failed: ${result.failure}`);
    }
    return result.path;
  }

  async failure(): Promise<string | null> {
    return (await this.completion).failure;
  }

  async cancel(): Promise<void> {
    await this.cancelDownload();
  }

  async delete(): Promise<void> {
    await this.completion;
    await removeOwnedFile(this.filePath);
  }
}

function isSafeFilename(filename: string): boolean {
  return (
    filename.length > 0 &&
    filename !== "." &&
    filename !== ".." &&
    !/[\\/\0]/.test(filename) &&
    !filename.endsWith(".crdownload")
  );
}

async function inspectDownloadFile(
  filePath: string,
  maxBytes: number,
): Promise<{ path?: string; bytes: number }> {
  let bytes = 0;
  let path: string | undefined;
  let partials = 0;
  for (const [candidate, isPartial] of [
    [`${filePath}.crdownload`, true],
    [filePath, false],
  ] as const) {
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) {
      throw new Error("download directory contains a non-regular file");
    }
    bytes += info.size;
    if (bytes > maxBytes) {
      throw new Error(`download exceeds maxDownloadBytes (${maxBytes} bytes)`);
    }
    if (isPartial) partials++;
    else path = candidate;
  }
  if (partials > 1 || (path && partials)) {
    throw new Error(
      "multiple download files make artifact ownership ambiguous",
    );
  }
  return { path, bytes };
}

async function bounded<T>(
  promise: Promise<T>,
  timeoutMs = CLEANUP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("download CDP request timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function removeOwnedFile(filePath: string): Promise<void> {
  ownedFiles.delete(filePath);
  await rm(filePath, { force: true });
  await rm(`${filePath}.crdownload`, { force: true });
}

// Every process that waits for a download leaves `waiters/<pid>` in the shared
// directory while it waits. The last live waiter restores the default
// behavior; the others leave it alone so their downloads keep landing here.
// A marker is rewritten while its process waits, so one that stopped aging
// belongs to a process that died and whose pid another process now holds.
function claimSharedBehavior(token: symbol): void {
  armedInterceptions.add(token);
  writeWaiterMarker();
  if (!waiterRefreshTimer) {
    waiterRefreshTimer = setInterval(writeWaiterMarker, WAITER_REFRESH_MS);
    waiterRefreshTimer.unref?.();
  }
}

function releaseSharedBehavior(token: symbol): boolean {
  armedInterceptions.delete(token);
  if (armedInterceptions.size > 0) return false;
  stopWaiterMarker();
  return !hasOtherLiveWaiter();
}

function writeWaiterMarker(): void {
  try {
    writeFileSync(
      waiterMarkerPath(),
      JSON.stringify({ pid: process.pid, since: Date.now() }),
    );
  } catch {
    // A read-only state directory only loses cross-process coordination.
  }
}

function stopWaiterMarker(): void {
  if (waiterRefreshTimer) clearInterval(waiterRefreshTimer);
  waiterRefreshTimer = undefined;
  rmSync(waiterMarkerPath(), { force: true });
}

function waiterMarkerPath(): string {
  return join(downloadDirectory(), WAITERS_DIRECTORY, String(process.pid));
}

function hasOtherLiveWaiter(): boolean {
  const waitersDirectory = join(downloadDirectory(), WAITERS_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(waitersDirectory);
  } catch {
    return false;
  }
  const now = Date.now();
  for (const name of names) {
    const path = join(waitersDirectory, name);
    const pid = Number(name);
    if (pid === process.pid) continue;
    let stale = !Number.isInteger(pid) || !isProcessAlive(pid);
    if (!stale) {
      try {
        stale = now - statSync(path).mtimeMs > STALE_WAITER_MS;
      } catch {
        continue;
      }
    }
    if (stale) {
      rmSync(path, { force: true });
      continue;
    }
    return true;
  }
  return false;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// Files a process could not clean up (a crash mid-download) would otherwise
// stay forever; anything older than a day is nobody's pending download.
function removeStaleFiles(directory: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_FILE_MS;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Another process may have removed it first.
    }
  }
}

function assertAbsolutePath(path: string, method: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new TypeError(`${method} requires an absolute file path`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Remove this process's download files and stop pending waits during SDK disposal. */
export function disposeDownloadArtifacts(): void {
  for (const dispose of [...activeInterceptions]) dispose();
  activeInterceptions.clear();
  activeDownloadTargets.clear();
  if (armedInterceptions.size > 0) {
    armedInterceptions.clear();
    if (sharedDirectory) stopWaiterMarker();
  }
  for (const path of ownedFiles) {
    rmSync(path, { force: true });
    rmSync(`${path}.crdownload`, { force: true });
  }
  ownedFiles.clear();
}
