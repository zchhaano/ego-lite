import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadBrowserToolSource,
  loadLearnedContext,
  runNodeSiteTool,
  validateLearning,
} from "../../dist/src/learning/index.js";

async function fixture(t, manifestChanges = {}) {
  const root = await mkdtemp(join(tmpdir(), "ego-learning-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDir = join(root, "example");
  await mkdir(join(siteDir, "notes"), { recursive: true });
  await mkdir(join(siteDir, "tools"));
  await mkdir(join(siteDir, "browser-tools"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const manifest = {
    id: "example",
    name: "Example",
    domains: ["example.com"],
    notes: [],
    ...manifestChanges,
  };
  await writeFile(join(siteDir, "manifest.json"), JSON.stringify(manifest));
  return { root, siteDir };
}

function tool(path, callable = "run") {
  return {
    path,
    callable,
    description: "A fixture tool",
    args: {},
    returns: { type: "string", description: "Fixture result" },
  };
}

test("validation never executes a tool, including one in a rejected manifest", async (t) => {
  for (const name of ["Example", ""]) {
    const { siteDir, root } = await fixture(t, {
      name,
      nodeTools: { run: tool("tools/run.js") },
    });
    const marker = join(root, "executed.txt");
    await writeFile(
      join(siteDir, "tools/run.js"),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\nexport function run() { return 'ok'; }`,
    );
    const errors = await validateLearning(siteDir);
    assert.equal(errors.length, name ? 0 : 1);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});

test("validation recognizes local function exports without executing them", async (t) => {
  const cases = [
    [
      "import './unavailable.js'; throw Error('must not run'); export function run() {}",
      "run",
      true,
    ],
    ["export async function run() { throw Error('unused'); }", "run", true],
    ["export const run = () => 'ok';", "run", true],
    ["const fn = function () {}; export { fn as run };", "run", true],
    ["export default function () {}", "default", true],
    ["export default () => 'ok';", "default", true],
    ["export const run = 42;", "run", false],
    ["export function another() {}", "run", false],
    ["export { run } from './missing.js';", "run", false],
    ["export const run = factory();", "run", false],
    ["export function run( {", "run", false],
  ];
  for (const [source, callable, valid] of cases) {
    const { siteDir } = await fixture(t, {
      nodeTools: { run: tool("tools/run.js", callable) },
    });
    await writeFile(join(siteDir, "tools/run.js"), source);
    const errors = await validateLearning(siteDir);
    assert.equal(errors.length === 0, valid, `${source}: ${errors.join("; ")}`);
  }
});

test("ordinary notes and explicitly executed tools still work", async (t) => {
  const { root, siteDir } = await fixture(t, {
    notes: ["notes/readme.md"],
    nodeTools: { run: tool("tools/run.js") },
    browserTools: { run: tool("browser-tools/run.js") },
  });
  await writeFile(join(siteDir, "notes/readme.md"), "Useful site notes");
  await writeFile(
    join(siteDir, "tools/run.js"),
    "export function run(ctx, args) { return ctx.prefix + args.value; }",
  );
  await writeFile(join(siteDir, "browser-tools/run.js"), "() => 'browser'");
  assert.deepEqual(await validateLearning(siteDir), []);
  const context = await loadLearnedContext("https://example.com", { root });
  assert.equal(context.knowledge[0].content, "Useful site notes");
  assert.equal(
    await runNodeSiteTool(
      "example",
      "run",
      { value: "ok" },
      { prefix: "node:" },
      { root },
    ),
    "node:ok",
  );
  assert.equal(
    await loadBrowserToolSource("example", "run", { root }),
    "() => 'browser'",
  );
});

test("note symlinks cannot disclose files outside the learning directory", async (t) => {
  for (const directoryLink of [false, true]) {
    const { root, siteDir } = await fixture(t, { notes: ["notes/secret.md"] });
    const outside = join(root, "private");
    await mkdir(outside);
    await writeFile(join(outside, "secret.md"), "synthetic private marker");
    if (directoryLink) {
      await rm(join(siteDir, "notes"), { recursive: true });
      await symlink(outside, join(siteDir, "notes"), "dir");
    } else {
      await symlink(
        join(outside, "secret.md"),
        join(siteDir, "notes/secret.md"),
      );
    }
    assert.ok((await validateLearning(siteDir)).length > 0);
    const context = await loadLearnedContext("https://example.com", { root });
    assert.deepEqual(context.knowledge, []);
  }
});

test("symlinked manifests and tool files are rejected before loading or execution", async (t) => {
  for (const kind of ["manifest", "node", "browser"]) {
    const { root, siteDir } = await fixture(t, {
      nodeTools: { run: tool("tools/run.js") },
      browserTools: { run: tool("browser-tools/run.js") },
    });
    const marker = join(root, "executed.txt");
    const outside = join(root, "outside.js");
    const target =
      kind === "manifest"
        ? "manifest.json"
        : kind === "node"
          ? "tools/run.js"
          : "browser-tools/run.js";
    await writeFile(
      join(siteDir, "tools/run.js"),
      "export function run() { return 'ok'; }",
    );
    await writeFile(join(siteDir, "browser-tools/run.js"), "() => 'ok'");
    await writeFile(
      outside,
      kind === "manifest"
        ? await readFile(join(siteDir, target))
        : `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export function run() {}`,
    );
    await rm(join(siteDir, target));
    await symlink(outside, join(siteDir, target));
    assert.ok((await validateLearning(siteDir)).length > 0);
    if (kind === "manifest") {
      assert.equal(
        (await loadLearnedContext("https://example.com", { root })).exists,
        false,
      );
    } else if (kind === "node") {
      await assert.rejects(
        runNodeSiteTool("example", "run", {}, {}, { root }),
        /symlink|symbolic/i,
      );
    } else {
      await assert.rejects(
        loadBrowserToolSource("example", "run", { root }),
        /symlink|symbolic/i,
      );
    }
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});

test("oversized and non-regular notes are rejected without returning their content", async (t) => {
  for (const directory of [false, true]) {
    const { root, siteDir } = await fixture(t, { notes: ["notes/large.md"] });
    if (directory) await mkdir(join(siteDir, "notes/large.md"));
    else
      await writeFile(
        join(siteDir, "notes/large.md"),
        "x".repeat(1024 * 1024 + 1),
      );
    assert.ok((await validateLearning(siteDir)).length > 0);
    assert.deepEqual(
      (await loadLearnedContext("https://example.com", { root })).knowledge,
      [],
    );
  }
});

test("a symlinked site root or tool directory is rejected", async (t) => {
  const { root, siteDir } = await fixture(t, {
    nodeTools: { run: tool("tools/run.js") },
  });
  const outside = join(root, "private-tools");
  const marker = join(root, "executed.txt");
  await mkdir(outside);
  await writeFile(
    join(outside, "run.js"),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export function run() {}`,
  );
  await rm(join(siteDir, "tools"), { recursive: true });
  await symlink(outside, join(siteDir, "tools"), "dir");
  assert.ok((await validateLearning(siteDir)).length > 0);
  await assert.rejects(
    runNodeSiteTool("example", "run", {}, {}, { root }),
    /symlink|symbolic/i,
  );
  const siteAlias = join(root, "alias");
  await symlink(siteDir, siteAlias, "dir");
  assert.match(
    (await validateLearning(siteAlias)).join("\n"),
    /symlink|symbolic/i,
  );
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("tool paths cannot traverse out of their site directory", async (t) => {
  const { root } = await fixture(t, {
    browserTools: { run: tool("../private.js") },
  });
  await writeFile(join(root, "private.js"), "synthetic private marker");
  await assert.rejects(
    loadBrowserToolSource("example", "run", { root }),
    /relative|inside/i,
  );
});
