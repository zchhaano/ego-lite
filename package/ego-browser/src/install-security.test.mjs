import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  chmod,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installer = new URL(
  "../../../skills/ego-browser/scripts/install.sh",
  import.meta.url,
);

async function runInstaller(
  t,
  {
    existing = false,
    valid = true,
    team = "JGQLC6YQYJ",
    bundle = "com.citrolabs.ego.lite",
    gatekeeper = true,
    pkg = false,
    finderInfo = false,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ego-install-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const apps = join(root, "apps");
  await mkdir(apps);
  const fixture = existing
    ? join(apps, "ego lite.app")
    : join(root, "payload", "ego lite.app");
  await mkdir(join(fixture, "Contents"), { recursive: true });
  await writeFile(
    join(fixture, "Contents", "ego-browser"),
    "fixture, never executed",
  );
  await chmod(join(fixture, "Contents", "ego-browser"), 0o755);
  await writeFile(
    join(fixture, "security.json"),
    JSON.stringify({
      valid,
      team,
      bundle,
      gatekeeper,
      finderInfo,
      quarantine: "preserved",
    }),
  );
  // Redirect only the fixed deployment paths. All installer control flow and native
  // command arguments are exercised unchanged, without touching real applications.
  const source = (await readFile(installer, "utf8"))
    .replace(
      'APP_PATH="/Applications/$APP_BUNDLE_NAME"',
      `APP_PATH="${apps}/$APP_BUNDLE_NAME"`,
    )
    .replace(
      'USER_APP_PATH="$HOME/Applications/$APP_BUNDLE_NAME"',
      `USER_APP_PATH="${root}/user-apps/$APP_BUNDLE_NAME"`,
    );
  const script = join(root, "install.sh");
  await writeFile(script, source);
  const driver = join(bin, "native-command");
  await writeFile(
    driver,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const root = process.env.INSTALL_FIXTURE_ROOT;
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({command, args}) + '\\n');
const fail = () => process.exit(1);
if (command === 'uname') console.log(args[0] === '-s' ? 'Darwin' : 'arm64');
else if (command === 'curl') fs.writeFileSync(args[args.indexOf('--output') + 1], 'dmg fixture');
else if (command === 'hdiutil' && args[0] === 'attach') {
  const mount = args[args.indexOf('-mountpoint') + 1];
  if (process.env.INSTALL_FIXTURE_PKG === '1') fs.writeFileSync(path.join(mount, 'untrusted.pkg'), 'pkg');
  else fs.cpSync(path.join(root, 'payload', 'ego lite.app'), path.join(mount, 'ego lite.app'), {recursive: true});
} else if (command === 'ditto') fs.cpSync(args[0], args[1], {recursive: true});
else if (command === 'codesign') {
  const data = JSON.parse(fs.readFileSync(path.join(args.at(-1), 'security.json')));
  const requirement = args.find(value => value.startsWith('--test-requirement=')) || args[args.indexOf('-R') + 1] || '';
  if (!args.includes('--verify') || !args.includes('--deep') || !args.includes('--strict')) fail();
  if (!requirement.includes('anchor apple generic') || !requirement.includes('identifier "com.citrolabs.ego.lite"') || !requirement.includes('certificate leaf[subject.OU] = "JGQLC6YQYJ"')) fail();
  if (data.finderInfo || !data.valid || data.team !== 'JGQLC6YQYJ' || data.bundle !== 'com.citrolabs.ego.lite') fail();
} else if (command === 'spctl') {
  if (!args.includes('--assess') || args[args.indexOf('--type') + 1] !== 'execute') fail();
  if (!JSON.parse(fs.readFileSync(path.join(args.at(-1), 'security.json'))).gatekeeper) fail();
} else if (command === 'mv') fs.renameSync(args[0], args[1]);
else if (command === 'xattr') {
  if (JSON.stringify(args.slice(0, 4)) !== JSON.stringify(['-r', '-s', '-d', 'com.apple.FinderInfo'])) process.exit(97);
  const file = path.join(args.at(-1), 'security.json');
  const data = JSON.parse(fs.readFileSync(file));
  data.finderInfo = false;
  fs.writeFileSync(file, JSON.stringify(data));
}
else if (['sudo', 'installer'].includes(command)) process.exit(97);
`,
  );
  await chmod(driver, 0o755);
  for (const command of [
    "uname",
    "curl",
    "hdiutil",
    "ditto",
    "codesign",
    "spctl",
    "mv",
    "open",
    "sudo",
    "installer",
    "xattr",
  ]) {
    await symlink(driver, join(bin, command));
  }
  const result = spawnSync("/bin/sh", [script], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: root,
      INSTALL_FIXTURE_ROOT: root,
      INSTALL_FIXTURE_PKG: pkg ? "1" : "0",
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  let installedSecurity;
  try {
    installedSecurity = JSON.parse(
      await readFile(join(apps, "ego lite.app", "security.json"), "utf8"),
    );
  } catch {}
  return { ...result, calls, installedSecurity };
}

for (const existing of [false, true]) {
  for (const [name, changes] of [
    ["invalid signature", { valid: false }],
    ["another developer", { team: "ATTACKER01" }],
    ["another application", { bundle: "com.example.fake" }],
    ["Gatekeeper rejection", { gatekeeper: false }],
  ]) {
    test(`installer refuses ${existing ? "existing" : "downloaded"} app with ${name}`, async (t) => {
      const result = await runInstaller(t, { existing, ...changes });
      assert.notEqual(result.status, 0, result.stderr);
      assert.equal(
        result.calls.some(({ command }) =>
          ["open", "mv", "sudo", "installer"].includes(command),
        ),
        false,
      );
      assert.ok(result.calls.some(({ command }) => command === "codesign"));
    });
  }
}

test("installer verifies a downloaded app before moving it and verifies it again before launch", async (t) => {
  const result = await runInstaller(t);
  assert.equal(result.status, 0, result.stderr);
  const commands = result.calls.map(({ command }) => command);
  assert.deepEqual(
    commands.filter((command) =>
      [
        "codesign",
        "spctl",
        "mv",
        "open",
        "xattr",
        "installer",
        "sudo",
      ].includes(command),
    ),
    ["xattr", "codesign", "spctl", "mv", "codesign", "spctl", "open"],
  );
  const curl = result.calls.find(({ command }) => command === "curl").args;
  assert.equal(curl[curl.indexOf("--proto") + 1], "=https");
  assert.equal(curl[curl.indexOf("--proto-redir") + 1], "=https");
});

test("installer verifies an existing app without downloading or removing quarantine", async (t) => {
  const result = await runInstaller(t, { existing: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.calls.map(({ command }) => command),
    ["uname", "codesign", "spctl", "open"],
  );
});

test("installer rejects a PKG-only disk image without running installer or sudo", async (t) => {
  const result = await runInstaller(t, { pkg: true });
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(
    result.calls.some(({ command }) =>
      ["installer", "sudo", "open", "xattr"].includes(command),
    ),
    false,
  );
});

test("downloaded Finder metadata is normalized while quarantine and original signature checks remain", async (t) => {
  const result = await runInstaller(t, { finderInfo: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.installedSecurity.finderInfo, false);
  assert.equal(result.installedSecurity.quarantine, "preserved");
  assert.equal(
    result.calls.filter(({ command }) => command === "codesign").length,
    2,
  );
  const normalization = result.calls.find(({ command }) => command === "xattr");
  assert.deepEqual(normalization.args.slice(0, 4), [
    "-r",
    "-s",
    "-d",
    "com.apple.FinderInfo",
  ]);
});

test("removing Finder metadata cannot rescue an invalid original signature", async (t) => {
  const result = await runInstaller(t, { finderInfo: true, valid: false });
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(
    result.calls.some(({ command }) =>
      ["open", "mv", "sudo"].includes(command),
    ),
    false,
  );
});

test("existing apps are rejected without changing their Finder metadata", async (t) => {
  const result = await runInstaller(t, { existing: true, finderInfo: true });
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(
    result.calls.some(({ command }) =>
      ["xattr", "open", "mv"].includes(command),
    ),
    false,
  );
});

test(
  "native Finder metadata cleanup preserves quarantine and does not follow external links",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ego-finder-metadata-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const app = join(root, "staged.app");
    await mkdir(app);
    const inside = join(app, "inside");
    const outside = join(root, "outside");
    await writeFile(inside, "synthetic app data");
    await writeFile(outside, "synthetic external data");
    await symlink(outside, join(app, "external-link"));
    const xattr = (...args) =>
      spawnSync("/usr/bin/xattr", args, { encoding: "utf8" });
    const finder =
      "0000000000000000400000000000000000000000000000000000000000000000";
    for (const path of [inside, outside])
      assert.equal(
        xattr("-w", "-x", "com.apple.FinderInfo", finder, path).status,
        0,
      );
    assert.equal(
      xattr("-w", "com.apple.quarantine", "0081;00000000;Diagnostic;", inside)
        .status,
      0,
    );
    const externalBefore = xattr(
      "-p",
      "-x",
      "com.apple.FinderInfo",
      outside,
    ).stdout;
    assert.equal(
      xattr("-r", "-s", "-d", "com.apple.FinderInfo", app).status,
      0,
    );
    assert.notEqual(xattr("-p", "com.apple.FinderInfo", inside).status, 0);
    assert.equal(
      xattr("-p", "-x", "com.apple.FinderInfo", outside).stdout,
      externalBefore,
    );
    assert.equal(
      xattr("-p", "com.apple.quarantine", inside).stdout.trim(),
      "0081;00000000;Diagnostic;",
    );
    assert.equal(await readFile(inside, "utf8"), "synthetic app data");
    assert.equal(await readFile(outside, "utf8"), "synthetic external data");
  },
);
