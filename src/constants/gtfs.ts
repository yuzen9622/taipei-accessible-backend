/**
 * Shared GTFS import constants — the on-disk location of the GTFS feed,
 * referenced identically by every `import:gtfs-*` script. Lives two levels
 * under the compiled root (src/ or dist/), so `../../data/gtfs` resolves to the
 * project-root `data/gtfs` directory in both dev and build.
 */

import path from "path";

export const GTFS_DIR = path.resolve(__dirname, "../../data/gtfs");
