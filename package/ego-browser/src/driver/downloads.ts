import { mkdtempSync, rmSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

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
const artifactDirectories = new Set<string>();
const activeInterceptions = new Set<() => void>();
const activeDownloadTargets = new Set<string>();
const CLEANUP_TIMEOUT_MS = 1_000;

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

/** Arm one Page session without changing shared BrowserContext download behavior. */
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
  if (activeDownloadTargets.has(targetId))
    throw new Error(`${targetId} is already waiting for a download`);
  const directory = mkdtempSync(join(tmpdir(), "ego-browser-download-"));
  activeDownloadTargets.add(targetId);
  artifactDirectories.add(directory);
  const configuredSessions = new Map<string, Promise<unknown>>();
  const guids = new Set<string>();
  let guid: string | undefined;
  let filename: string | undefined;
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

  const resetBehavior = async () => {
    const sessions = [...configuredSessions];
    configuredSessions.clear();
    return Promise.all(
      sessions.map(async ([sessionId, ready]) => {
        await bounded(ready).catch(() => {});
        return bounded(
          services.cdp(
            "Page.setDownloadBehavior",
            { behavior: "default" },
            sessionId,
            CLEANUP_TIMEOUT_MS,
          ),
        ).then(() => undefined, asError);
      }),
    );
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
    finishing = (async () => {
      if (cancel) for (const downloadGuid of guids) cancelNative(downloadGuid);
      // Keep observing new GUIDs while the Page still accepts downloads. A late
      // start must be canceled too, even when the original transfer has finished.
      const restoreErrors = await resetBehavior();
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
      if (result.failure !== null) {
        try {
          await removeArtifactDirectory(directory);
        } catch (error) {
          result = {
            failure: `${result.failure}; cleanup failed: ${asError(error).message}`,
          };
        }
        rejectEvent(new Error(result.failure!));
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
    filePollTimer = setTimeout(() => void checkForDownloadedFile(), 50);
  };
  const checkForDownloadedFile = async () => {
    filePollTimer = undefined;
    if (settled || !filename || checking) return;
    checking = true;
    try {
      const result = await inspectDownloadDirectory(
        directory,
        filename,
        maxDownloadBytes,
      );
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
      )
        return;
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
        if (guid !== params.guid)
          fail(
            "multiple downloads started in one Page; artifact ownership is ambiguous",
          );
        return;
      }
      guid = params.guid;
      clearTimeout(startTimer);
      if (!isSafeFilename(params.suggestedFilename)) {
        fail("download has an unsafe or unsupported suggested filename");
        return;
      }
      filename = params.suggestedFilename;
      resolveEvent(
        new PageDownloadArtifact(
          params.url,
          params.suggestedFilename,
          directory,
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
    )
      return;
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
      if (settled) throw new Error("download waiter is no longer active");
      const ready = services.cdp(
        "Page.setDownloadBehavior",
        { behavior: "allow", downloadPath: directory },
        sessionId,
      );
      configuredSessions.set(sessionId, ready);
      await bounded(ready, timeoutMs);
      if (settled) throw new Error("download waiter is no longer active");
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
    private readonly directory: string,
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
    if (!("path" in result))
      throw new Error(`download failed: ${result.failure}`);
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
    await removeArtifactDirectory(this.directory);
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
async function inspectDownloadDirectory(
  directory: string,
  filename: string,
  maxBytes: number,
): Promise<{ path?: string; bytes: number }> {
  const entries = await readdir(directory);
  let bytes = 0;
  let path: string | undefined;
  let partials = 0;
  for (const name of entries) {
    const candidate = join(directory, name);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      // Chromium may rename its partial file between readdir and lstat.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes };
      throw error;
    }
    if (!info.isFile())
      throw new Error("download directory contains a non-regular file");
    bytes += info.size;
    if (bytes > maxBytes)
      throw new Error(`download exceeds maxDownloadBytes (${maxBytes} bytes)`);
    if (name.endsWith(".crdownload")) partials++;
    else if (name === filename) path = candidate;
    else throw new Error(`download contains an unexpected filename: ${name}`);
  }
  if (partials > 1 || (path && partials))
    throw new Error(
      "multiple download files make artifact ownership ambiguous",
    );
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
async function removeArtifactDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  artifactDirectories.delete(directory);
}
function assertAbsolutePath(path: string, method: string): void {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path))
    throw new TypeError(`${method} requires an absolute file path`);
}
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
/** Remove round-local files and stop pending waits during SDK disposal. */
export function disposeDownloadArtifacts(): void {
  for (const dispose of [...activeInterceptions]) dispose();
  activeInterceptions.clear();
  for (const directory of artifactDirectories)
    rmSync(directory, { recursive: true, force: true });
  artifactDirectories.clear();
}
