/**
 * Normalize a rail station name for exact matching: 台→臺, drop a trailing
 * 「車站」/「站」, and trim. Shared by the rail parse layer (building the index)
 * and the train service (looking names up) so both key on the same form.
 *
 * @param name The raw station name.
 * @returns The normalized name.
 */
export function normalizeStationName(name: string): string {
  return name
    .replace(/台/g, "臺")
    .replace(/(車站|站)$/, "")
    .trim();
}
