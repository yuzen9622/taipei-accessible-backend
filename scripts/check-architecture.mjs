#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const srcDir = path.join(root, "src");
const allowlist = new Set([
  // Keep intentional legacy exceptions explicit and removable.
]);

function toRel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function roleFor(file) {
  if (file.endsWith(".router.ts")) return "router";
  if (file.endsWith(".controller.ts")) return "controller";
  if (file.endsWith(".service.ts")) return "service";
  if (file.endsWith(".schema.ts")) return "schema";
  return undefined;
}

function moduleFor(file) {
  const rel = toRel(file);
  const match = /^src\/modules\/([^/]+)\//.exec(rel);
  return match?.[1];
}

function importSpecs(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^"'()]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

function resolveRelative(fromFile, spec) {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), spec);
  const normalizedBase = base.endsWith(".js") ? base.slice(0, -3) : base;
  const candidates = [
    normalizedBase,
    `${normalizedBase}.ts`,
    `${normalizedBase}.tsx`,
    path.join(normalizedBase, "index.ts"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function addViolation(violations, fromFile, spec, reason) {
  const key = `${toRel(fromFile)}::${spec}::${reason}`;
  if (allowlist.has(key)) return;
  violations.push(`${toRel(fromFile)} imports "${spec}" — ${reason}`);
}

const violations = [];
for (const file of walk(srcDir)) {
  if (file.endsWith(".test.ts")) continue;
  const role = roleFor(file);
  const source = fs.readFileSync(file, "utf8");
  for (const spec of importSpecs(source)) {
    const target = resolveRelative(file, spec);
    const targetRel = target ? toRel(target) : spec;
    const targetRole = target ? roleFor(target) : undefined;

    if (role === "router" && targetRole === "service") {
      addViolation(violations, file, spec, "routers must delegate through controllers, not services");
    }

    if (role === "controller") {
      if (targetRole === "router") {
        addViolation(violations, file, spec, "controllers must not import routers");
      }
      if (targetRole === "controller" && moduleFor(file) !== moduleFor(target)) {
        addViolation(violations, file, spec, "controllers must not import controllers from another module");
      }
      if (targetRel.startsWith("src/model/")) {
        addViolation(violations, file, spec, "controllers must not import models directly");
      }
    }

    if (role === "service") {
      if (spec === "express") {
        addViolation(violations, file, spec, "services must not import Express transport types");
      }
      if (targetRole === "controller" || targetRole === "router") {
        addViolation(violations, file, spec, "services must not import transport layers");
      }
    }

    if (role === "schema") {
      if (targetRel.startsWith("src/model/") || targetRel.startsWith("src/adapters/")) {
        addViolation(violations, file, spec, "schemas must stay I/O-free");
      }
    }
  }
}

if (violations.length) {
  console.error("Architecture boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Architecture boundary check passed.");
