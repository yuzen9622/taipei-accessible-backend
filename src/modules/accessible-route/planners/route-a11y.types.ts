/**
 * Type declarations for route accessibility enrichment.
 */

import type { MetroLeg, ThsrLeg, TraLeg } from "../../../types/route";

export type RailLeg = MetroLeg | ThsrLeg | TraLeg;
