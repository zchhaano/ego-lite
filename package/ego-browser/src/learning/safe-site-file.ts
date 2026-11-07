import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Learning files are small source/knowledge documents, not arbitrary attachments.
const MAX_LEARNING_FILE_BYTES = 1024 * 1024;

export function isSafeSiteRelativePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    Boolean(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !isAbsolute(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

/**
 * Read one bounded, regular learning file without following site-local symlinks.
 * Ancestors of the configured site root may be aliases (e.g. macOS /var).
 * This is a file-access guard, not a sandbox for explicitly executed Node tools;
 * those tools and their imports must still come from a trusted, stable package.
 */
export async function readSiteFile(siteDir: string, manifestPath: string) {
  if (!isSafeSiteRelativePath(manifestPath)) {
    throw new Error(
      "learning file path must stay relative to the site directory",
    );
  }
  const siteRoot = resolve(siteDir);
  const rootStat = await lstat(siteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("learning site root must be a directory, not a symlink");
  }
  const canonicalRoot = await realpath(siteRoot);
  const parts = manifestPath.split("/");
  let filePath = siteRoot;
  let expectedStat = rootStat;
  for (let index = 0; index < parts.length; index += 1) {
    filePath = join(filePath, parts[index]);
    expectedStat = await lstat(filePath);
    if (expectedStat.isSymbolicLink()) {
      throw new Error(`learning file path contains a symlink: ${manifestPath}`);
    }
    if (index < parts.length - 1 && !expectedStat.isDirectory()) {
      throw new Error(
        `learning file parent must be a directory: ${manifestPath}`,
      );
    }
  }
  if (!expectedStat.isFile()) {
    throw new Error(`learning file must be a regular file: ${manifestPath}`);
  }
  if (expectedStat.size > MAX_LEARNING_FILE_BYTES) {
    throw new Error(`learning file exceeds 1 MiB: ${manifestPath}`);
  }
  const canonicalFile = await realpath(filePath);
  const inside = relative(canonicalRoot, canonicalFile);
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    isAbsolute(inside)
  ) {
    throw new Error(
      `learning file must stay inside the site directory: ${manifestPath}`,
    );
  }

  const handle = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== expectedStat.dev ||
      openedStat.ino !== expectedStat.ino
    ) {
      throw new Error(`learning file changed while opening: ${manifestPath}`);
    }
    if (
      (await realpath(filePath)) !== canonicalFile ||
      (await realpath(siteRoot)) !== canonicalRoot
    ) {
      throw new Error(
        `learning file path changed while opening: ${manifestPath}`,
      );
    }
    const currentRootStat = await lstat(siteRoot);
    if (
      currentRootStat.isSymbolicLink() ||
      currentRootStat.dev !== rootStat.dev ||
      currentRootStat.ino !== rootStat.ino
    ) {
      throw new Error(
        `learning site root changed while opening: ${manifestPath}`,
      );
    }
    // A bounded buffer also limits a file which grows after the stat check.
    const buffer = Buffer.alloc(MAX_LEARNING_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_LEARNING_FILE_BYTES) {
      throw new Error(`learning file exceeds 1 MiB: ${manifestPath}`);
    }
    return {
      path: filePath,
      text: buffer.subarray(0, length).toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}
