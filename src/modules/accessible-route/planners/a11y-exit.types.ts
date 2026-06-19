/**
 * Type declarations for A11y station exit navigation.
 */

import type { IA11y } from "../../../types";

export type RawA11yDoc = IA11y;

export interface A11yExit {
  exitName: string;
  exitNumber: string;
  type: "elevator" | "ramp";
  coords: [number, number];
}
