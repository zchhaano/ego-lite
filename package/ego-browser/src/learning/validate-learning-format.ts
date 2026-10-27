import { parse } from "acorn";

import { iterLearningDirs, learningsRoot } from "./check-domain-learning.js";
import { isSafeSiteRelativePath, readSiteFile } from "./safe-site-file.js";

const TOOL_VALUE_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);
const TEMP_REF_RE = /(?:@\d+\b|\bref=\d+\b)/;

export async function validateLearning(siteDir: string) {
  const errors: string[] = [];
  const siteId = siteDir.split(/[\\/]/).at(-1);
  let manifest;
  try {
    manifest = JSON.parse((await readSiteFile(siteDir, "manifest.json")).text);
  } catch (error) {
    return [`${siteId}: invalid or missing manifest.json: ${error.message}`];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [`${siteId}: manifest.json must contain a JSON object`];
  }

  if (manifest.id !== siteId) {
    errors.push(`${siteId}: manifest id must match directory name`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    errors.push(`${siteId}: name must be a non-empty string`);
  }

  const domains = asStringList(manifest, "domains", errors, siteId);
  if (domains.length === 0) {
    errors.push(`${siteId}: domains must not be empty`);
  }
  for (const domain of domains) {
    if (!isValidDomain(domain)) {
      errors.push(`${siteId}: invalid domain ${JSON.stringify(domain)}`);
    }
  }

  for (const note of asStringList(manifest, "notes", errors, siteId)) {
    if (!isNotePath(note)) {
      errors.push(
        `${siteId}: notes must point to notes/*.md: ${JSON.stringify(note)}`,
      );
      continue;
    }
    await rejectTemporaryRefs(
      siteDir,
      note,
      `${siteId}: note ${JSON.stringify(note)}`,
      errors,
    );
  }

  const nodeTools: Record<string, any> = validateToolMap(
    manifest,
    "nodeTools",
    errors,
    siteId,
  );
  for (const [toolName, schema] of Object.entries(nodeTools)) {
    if (!schema || typeof schema !== "object" || !isNodeToolPath(schema.path)) {
      continue;
    }
    const source = await rejectTemporaryRefs(
      siteDir,
      schema.path,
      `${siteId}: Node tool ${JSON.stringify(toolName)}`,
      errors,
    );
    if (source === null) continue;
    try {
      const exportedFunctions = staticFunctionExports(source);
      if (
        typeof schema.callable === "string" &&
        !exportedFunctions.has(schema.callable)
      ) {
        errors.push(
          `${siteId}: Node callable ${JSON.stringify(schema.callable)} for tool ${JSON.stringify(toolName)} must be a statically declared local function export (re-exports and computed values are unsupported)`,
        );
      }
    } catch (error) {
      errors.push(
        `${siteId}: cannot parse Node tool ${JSON.stringify(schema.path)}: ${error.message}`,
      );
    }
  }

  const browserTools: Record<string, any> = validateToolMap(
    manifest,
    "browserTools",
    errors,
    siteId,
  );
  for (const [toolName, schema] of Object.entries(browserTools)) {
    if (
      !schema ||
      typeof schema !== "object" ||
      !isBrowserToolPath(schema.path)
    ) {
      continue;
    }
    await rejectTemporaryRefs(
      siteDir,
      schema.path,
      `${siteId}: browser tool ${JSON.stringify(toolName)}`,
      errors,
    );
  }

  return errors;
}

export async function validateLearnings(root = learningsRoot()) {
  const errors: string[] = [];
  for (const siteDir of await iterLearningDirs(root)) {
    errors.push(...(await validateLearning(siteDir)));
  }
  return errors;
}

export const validateSiteSkills = validateLearnings;

function asStringList(manifest, key, errors: string[], siteId: string) {
  const value = manifest[key] || [];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim())
  ) {
    errors.push(`${siteId}: ${key} must be a list of non-empty strings`);
    return [];
  }
  return value;
}

function validateToolMap(
  manifest,
  key,
  errors: string[],
  siteId: string,
): Record<string, any> {
  const value = manifest[key] || {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${siteId}: ${key} must be an object keyed by tool name`);
    return {};
  }
  for (const [toolName, schema] of Object.entries(value)) {
    validateToolSchema(siteId, key, toolName, schema, errors);
  }
  return value;
}

function validateToolSchema(
  siteId: string,
  key: string,
  toolName: string,
  schema,
  errors: string[],
) {
  const prefix = `${siteId}: ${key}.${toolName}`;
  if (!isSafeToolName(toolName)) {
    errors.push(
      `${siteId}: ${key} contains invalid tool name ${JSON.stringify(toolName)}`,
    );
    return;
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${prefix}: schema must be an object`);
    return;
  }
  if (typeof schema.description !== "string" || !schema.description.trim()) {
    errors.push(`${prefix}: description must be a non-empty string`);
  }
  if (key === "nodeTools") {
    if (!isNodeToolPath(schema.path)) {
      errors.push(`${prefix}: path must be a relative tools/*.js path`);
    }
    if (typeof schema.callable !== "string" || !schema.callable.trim()) {
      errors.push(`${prefix}: callable must be a non-empty string`);
    }
  } else if (!isBrowserToolPath(schema.path)) {
    errors.push(`${prefix}: path must be a relative browser-tools/*.js path`);
  }

  if (
    !schema.args ||
    typeof schema.args !== "object" ||
    Array.isArray(schema.args)
  ) {
    errors.push(`${prefix}: args must be an object`);
  } else {
    for (const [argName, argSchema] of Object.entries(schema.args)) {
      if (typeof argName !== "string" || !argName.trim()) {
        errors.push(
          `${prefix}: args contains invalid argument name ${JSON.stringify(argName)}`,
        );
        continue;
      }
      validateValueSchema(
        `${prefix}.args.${argName}`,
        argSchema,
        errors,
        true,
        "arg",
      );
    }
  }
  if (
    !schema.returns ||
    typeof schema.returns !== "object" ||
    Array.isArray(schema.returns)
  ) {
    errors.push(`${prefix}: returns must be an object`);
  } else {
    validateValueSchema(
      `${prefix}.returns`,
      schema.returns,
      errors,
      false,
      "return",
    );
  }
}

function validateValueSchema(
  prefix: string,
  schema,
  errors: string[],
  requireRequired: boolean,
  typeLabel: string,
) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${prefix}: schema must be an object`);
    return;
  }
  if (!TOOL_VALUE_TYPES.has(schema.type)) {
    errors.push(
      `${prefix}: invalid ${typeLabel} type ${JSON.stringify(schema.type)}`,
    );
  }
  if (requireRequired && typeof schema.required !== "boolean") {
    errors.push(`${prefix}: required must be a boolean`);
  }
  if (typeof schema.description !== "string" || !schema.description.trim()) {
    errors.push(`${prefix}: description must be a non-empty string`);
  }
}

function isValidDomain(pattern) {
  if (typeof pattern !== "string" || !pattern) {
    return false;
  }
  if (
    pattern.includes("://") ||
    pattern.includes("/") ||
    pattern.startsWith(".") ||
    pattern.endsWith(".")
  ) {
    return false;
  }
  if (pattern.includes("*")) {
    return (
      pattern.startsWith("*.") &&
      pattern.indexOf("*") === pattern.lastIndexOf("*") &&
      pattern.length > 2
    );
  }
  return true;
}

function isSafeToolName(name) {
  return (
    typeof name === "string" &&
    Boolean(name) &&
    !name.includes("/") &&
    !name.includes("\\") &&
    name !== "." &&
    name !== ".." &&
    !name.includes("..")
  );
}

function isNotePath(path) {
  const parts = isSafeSiteRelativePath(path) ? path.split("/") : [];
  return parts.length === 2 && parts[0] === "notes" && parts[1].endsWith(".md");
}

function isNodeToolPath(path) {
  const parts = isSafeSiteRelativePath(path) ? path.split("/") : [];
  return parts.length === 2 && parts[0] === "tools" && parts[1].endsWith(".js");
}

function isBrowserToolPath(path) {
  const parts = isSafeSiteRelativePath(path) ? path.split("/") : [];
  return (
    parts.length === 2 &&
    parts[0] === "browser-tools" &&
    parts[1].endsWith(".js")
  );
}

async function rejectTemporaryRefs(
  siteDir: string,
  relativePath: string,
  prefix: string,
  errors: string[],
) {
  let text;
  try {
    text = (await readSiteFile(siteDir, relativePath)).text;
  } catch (error) {
    errors.push(
      `${prefix}: cannot read ${JSON.stringify(relativePath)}: ${error.message}`,
    );
    return null;
  }
  if (TEMP_REF_RE.test(text)) {
    errors.push(
      `${prefix}: contains temporary snapshot ref; use stable locators instead`,
    );
  }
  return text;
}

function staticFunctionExports(source: string) {
  const module = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const bindings = new Set<string>();
  const exports = new Set<string>();
  const isFunction = (node) =>
    node &&
    [
      "FunctionDeclaration",
      "FunctionExpression",
      "ArrowFunctionExpression",
    ].includes(node.type);
  for (const statement of module.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      bindings.add(declaration.id.name);
    } else if (declaration?.type === "VariableDeclaration") {
      for (const binding of declaration.declarations) {
        if (binding.id.type === "Identifier" && isFunction(binding.init))
          bindings.add(binding.id.name);
      }
    }
  }
  for (const statement of module.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      if (
        isFunction(statement.declaration) ||
        (statement.declaration.type === "Identifier" &&
          bindings.has(statement.declaration.name))
      )
        exports.add("default");
    } else if (
      statement.type === "ExportNamedDeclaration" &&
      !statement.source
    ) {
      if (statement.declaration?.type === "FunctionDeclaration") {
        exports.add(statement.declaration.id.name);
      } else if (statement.declaration?.type === "VariableDeclaration") {
        for (const binding of statement.declaration.declarations) {
          if (binding.id.type === "Identifier" && bindings.has(binding.id.name))
            exports.add(binding.id.name);
        }
      }
      for (const specifier of statement.specifiers) {
        if (
          specifier.local.type === "Identifier" &&
          bindings.has(specifier.local.name)
        )
          exports.add(
            specifier.exported.type === "Identifier"
              ? specifier.exported.name
              : String(specifier.exported.value),
          );
      }
    }
  }
  return exports;
}
