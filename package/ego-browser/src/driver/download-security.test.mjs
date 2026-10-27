import test from "node:test";
import assert from "node:assert/strict";
import { access, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { preparePageDownload } from "../../dist/src/driver/downloads.js";

async function fixture(t, options = {}, cancelError) {
  let listener;
  let directory;
  const calls = [];
  const interception = preparePageDownload(
    {
      async cdp(method, params) {
        calls.push({ method, params });
        if (
          method === "Page.setDownloadBehavior" &&
          params.behavior === "allow"
        )
          directory = params.downloadPath;
        if (method === "Target.getTargetInfo")
          return { targetInfo: { browserContextId: "context-security" } };
        if (method === "Browser.cancelDownload" && cancelError === "hang")
          return new Promise(() => {});
        if (method === "Browser.cancelDownload" && cancelError)
          throw cancelError;
        return {};
      },
      subscribePageEvents(_id, callback) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
    `security-${t.name}`,
    {
      timeoutMs: 1_000,
      downloadTimeoutMs: 500,
      downloadIdleTimeoutMs: 300,
      ...options,
    },
  );
  t.after(() => interception.dispose());
  await interception.ready("session-security");
  const emit = (method, params) => listener?.({ method, params });
  const begin = (guid = "first", suggestedFilename = "expected.txt") =>
    emit("Page.downloadWillBegin", {
      guid,
      suggestedFilename,
      url: `https://example.test/${guid}`,
    });
  begin();
  const download = await interception.event;
  t.after(() => download.delete());
  return { download, directory, calls, begin, emit };
}

async function boundedFailure(download) {
  let timer;
  try {
    return await Promise.race([
      download.failure(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("download never settled")),
          1500,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("a second download cannot supply the first download's artifact", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "expected.txt.crdownload"), "partial");
  await writeFile(join(f.directory, "other.txt"), "unrelated");
  f.begin("second", "other.txt");
  assert.match(await boundedFailure(f.download), /multiple|ambiguous/i);
  await assert.rejects(f.download.path(), /download failed/);
  assert(
    f.calls.some(
      (c) =>
        c.method === "Browser.cancelDownload" && c.params.guid === "second",
    ),
  );
});

test("an unexpected filename is rejected even without a second begin event", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "other.txt"), "unrelated");
  assert.match(await boundedFailure(f.download), /unexpected|filename/i);
  await assert.rejects(f.download.path(), /download failed/);
});

test("a started download has an inactivity deadline", async (t) => {
  const f = await fixture(t, { downloadIdleTimeoutMs: 40 });
  assert.match(await boundedFailure(f.download), /inactive|progress/i);
  await assert.rejects(access(f.directory));
});

test("progress cannot extend the total download deadline", async (t) => {
  const f = await fixture(t, {
    downloadTimeoutMs: 80,
    downloadIdleTimeoutMs: 60,
  });
  let bytes = 0;
  const interval = setInterval(
    () =>
      f.emit("Page.downloadProgress", {
        guid: "first",
        state: "inProgress",
        receivedBytes: ++bytes,
      }),
    10,
  );
  t.after(() => clearInterval(interval));
  assert.match(await boundedFailure(f.download), /timed out|deadline/i);
});

test("oversized progress cancels the transfer and removes partial files", async (t) => {
  const f = await fixture(t, { maxDownloadBytes: 4 });
  await writeFile(join(f.directory, "expected.txt.crdownload"), "part");
  f.emit("Page.downloadProgress", {
    guid: "first",
    state: "inProgress",
    receivedBytes: 5,
    totalBytes: 0,
  });
  assert.match(await boundedFailure(f.download), /byte|size/i);
  await assert.rejects(access(f.directory));
});

test("disk size enforces the limit when progress events are absent", async (t) => {
  const f = await fixture(t, { maxDownloadBytes: 4 });
  await writeFile(join(f.directory, "expected.txt"), "12345");
  assert.match(await boundedFailure(f.download), /byte|size/i);
  await assert.rejects(f.download.path(), /download failed/);
});

test("cancel settles without waiting for a browser cancellation event", async (t) => {
  const f = await fixture(t);
  await f.download.cancel();
  assert.equal(await boundedFailure(f.download), "canceled");
  await assert.rejects(access(f.directory));
});

test("a native cancellation error still settles and cleans up the download", async (t) => {
  const f = await fixture(t, {}, new Error("native cancellation denied"));
  await assert.rejects(f.download.cancel(), /native cancellation denied/);
  assert.match(await boundedFailure(f.download), /canceled|cancellation/);
  await assert.rejects(access(f.directory));
});

test("an unresponsive native cancellation cannot hang artifact cleanup", async (t) => {
  const f = await fixture(t, {}, "hang");
  await assert.rejects(f.download.cancel(), /timed out/);
  assert.match(await boundedFailure(f.download), /canceled|cancellation/);
  await assert.rejects(access(f.directory));
});

test("an unresponsive setup cannot keep ready waiting indefinitely", async (t) => {
  const interception = preparePageDownload(
    {
      cdp(method, params) {
        return params.behavior === "allow"
          ? new Promise(() => {})
          : Promise.resolve({});
      },
      subscribePageEvents() {
        return () => {};
      },
    },
    "target-unresponsive-setup",
    { timeoutMs: 10 },
  );
  t.after(() => interception.dispose());
  let timer;
  const outcome = await Promise.race([
    interception.ready("session-unresponsive").then(
      () => "ready",
      () => "rejected",
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("hung"), 100);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome, "rejected");
});

test("failed Page restoration does not return a successful download artifact", async (t) => {
  let listener;
  let directory;
  const interception = preparePageDownload(
    {
      async cdp(method, params) {
        if (method === "Page.setDownloadBehavior") {
          if (params.behavior === "default")
            throw new Error("native restore failed");
          directory = params.downloadPath;
        }
        return {};
      },
      subscribePageEvents(_target, callback) {
        listener = callback;
        return () => {};
      },
    },
    "target-restore-failure",
    { timeoutMs: 1000 },
  );
  t.after(() => interception.dispose());
  await interception.ready("session-restore-failure");
  listener({
    method: "Page.downloadWillBegin",
    params: {
      guid: "restore-failure",
      url: "https://example.test/file",
      suggestedFilename: "file.txt",
    },
  });
  const download = await interception.event;
  t.after(() => download.delete());
  await writeFile(join(directory, "file.txt"), "complete");
  assert.match(await boundedFailure(download), /restore|restor/);
  await assert.rejects(download.path(), /download failed/);
});

test("a symlink with the expected filename is never returned", async (t) => {
  const f = await fixture(t);
  await symlink(
    "/nonexistent-synthetic-download-target",
    join(f.directory, "expected.txt"),
  );
  assert.match(await boundedFailure(f.download), /non-regular/i);
  await assert.rejects(f.download.path(), /download failed/);
});

test("unchanged progress notifications cannot keep a stalled download alive", async (t) => {
  const f = await fixture(t, { downloadIdleTimeoutMs: 40 });
  const interval = setInterval(
    () =>
      f.emit("Page.downloadProgress", {
        guid: "first",
        state: "inProgress",
        receivedBytes: 0,
      }),
    5,
  );
  t.after(() => clearInterval(interval));
  assert.match(await boundedFailure(f.download), /inactive/i);
});

test("limits reject values that overflow timers or lose integer precision", () => {
  for (const options of [
    { downloadTimeoutMs: 2 ** 31 },
    { downloadIdleTimeoutMs: Infinity },
    { maxDownloadBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maxDownloadBytes: 0 },
  ]) {
    assert.throws(
      () =>
        preparePageDownload({}, "invalid-limits", {
          timeoutMs: 1000,
          ...options,
        }),
      TypeError,
    );
  }
});

test("downloads starting during cleanup are canceled before the waiter releases its Page", async (t) => {
  const listeners = new Set();
  const canceled = [];
  let restore;
  const restoring = new Promise((resolve) => {
    restore = resolve;
  });
  const interception = preparePageDownload(
    {
      async cdp(method, params) {
        if (
          method === "Page.setDownloadBehavior" &&
          params.behavior === "default"
        )
          await restoring;
        if (method === "Target.getTargetInfo")
          return { targetInfo: { browserContextId: "draining-context" } };
        if (method === "Browser.cancelDownload") canceled.push(params.guid);
        return {};
      },
      subscribePageEvents(_target, listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    "target-draining",
    { timeoutMs: 1000 },
  );
  t.after(async () => {
    restore();
    await interception.dispose();
  });
  await interception.ready("session-draining");
  const begin = (guid) => {
    for (const listener of listeners)
      listener({
        method: "Page.downloadWillBegin",
        params: {
          guid,
          url: `https://example.test/${guid}`,
          suggestedFilename: `${guid}.txt`,
        },
      });
  };
  begin("first");
  const download = await interception.event;
  begin("second");
  await new Promise((resolve) => setImmediate(resolve));
  begin("third");
  restore();
  assert.match(await boundedFailure(download), /multiple|ambiguous/);
  assert.deepEqual(canceled.sort(), ["first", "second", "third"]);
  assert.equal(listeners.size, 0);
});
