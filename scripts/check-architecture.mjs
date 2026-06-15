#!/usr/bin/env node
/**
 * Architecture boundary check (clean-backend-architecture invariant #2).
 * Zero-dependency: scans src/ import specifiers and fails loudly when a layer
 * boundary is crossed. Wired as `npm run lint:arch`.
 *
 * Rules:
 *   1. A service (*.service.ts or modules/<m>/planners/*) must not import a
 *      *.controller or *.router (domain never depends on transport).
 *   2. A controller (*.controller.ts) must not import a Mongoose model
 *      (src/model/*) directly — go through a service.
 *   3. A controller must not import another feature module (cross-module
 *      coupling) — depend on shared utils/adapters/types, or your own service.
 *   4. A router (*.router.ts) must not import a service/planner directly —
 *      it wires middleware + a controller.
 *
 * Add a path substring to ALLOWLIST to grandfather a not-yet-migrated file;
 * remove the entry in the same change that fixes it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
const ALLOWLIST = []; // e.g. "modules/legacy/legacy.controller.ts"

/** Recursively collect .ts files (excluding .d.ts). */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** All static + dynamic import specifiers in a source file. */
function importsOf(text) {
  const specs = [];
  const staticRe = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]/g;
  const dynRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(staticRe)) specs.push(m[1]);
  for (const m of text.matchAll(dynRe)) specs.push(m[1]);
  return specs;
}

const violations = [];
const add = (file, rule, spec) =>
  violations.push({ file: file.replace(/\\/g, "/"), rule, spec });

for (const file of walk(ROOT)) {
  const rel = file.replace(/\\/g, "/");
  if (ALLOWLIST.some((a) => rel.includes(a))) continue;

  const base = rel.split("/").pop();
  const isService = base.endsWith(".service.ts") || /\/planners\//.test(rel);
  const isController = base.endsWith(".controller.ts");
  const isRouter = base.endsWith(".router.ts");
  const myModule = rel.match(/^src\/modules\/([^/]+)\//)?.[1];

  for (const spec of importsOf(readFileSync(file, "utf8"))) {
    if (isService && /\.(controller|router)$/.test(spec)) {
      add(rel, "service imports transport (controller/router)", spec);
    }
    if (isController && /(^|\/)model\//.test(spec)) {
      add(rel, "controller imports a model directly", spec);
    }
    if (isController && myModule) {
      const sibling = spec.match(/^\.\.\/([^./][^/]*)/)?.[1];
      if (sibling && sibling !== myModule) {
        add(rel, `controller imports another module ('${sibling}')`, spec);
      }
    }
    if (isRouter && (/\.service$/.test(spec) || /\/planners\//.test(spec))) {
      add(rel, "router imports a service/planner directly", spec);
    }
  }
}

if (violations.length) {
  console.error(`\n✗ architecture boundary violations (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}\n      ${v.rule}\n      → import "${v.spec}"\n`);
  }
  console.error("Fix the layering, or allowlist the file in scripts/check-architecture.mjs.\n");
  process.exit(1);
}

console.log("✓ architecture boundaries OK");
