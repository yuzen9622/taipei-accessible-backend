/**
 * Evidence-based accessibility scoring for wheelchair route planning.
 *
 * Factor taxonomy and weights are derived from the following peer-reviewed
 * literature and standards:
 *
 * [CHI25]    Li et al. "Accessibility for Whom?" CHI 2025. N=190 mobility aid users.
 *            Missing curb ramps = #1 barrier; 24% passable for manual WC.
 * [Huang25]  Huang et al. "Measuring Spatial Accessibility for Wheelchair Users"
 *            PLoS ONE 2025. Facility type 53.6%, travel mode 41%, slope 5.4%.
 * [Scoping]  MDPI IJGI 2025 scoping review, 24 studies: sidewalks 96%, ramps 63%,
 *            curb cuts 54%, stairs 50%, crosswalks 50%.
 * [Choi15]   Choi et al. "Effects of Ramp Slope on Physiological Characteristics"
 *            PMC 2015. 1:12 (8.33%) validated safe upper bound.
 * [TW-MOI]   Taiwan MOI 建築物無障礙設施設計規範 2019. Ramp max 1:12, cross slope ≤2%,
 *            outdoor path width ≥130 cm, ramp width ≥90 cm.
 * [OSM-WC]   OpenStreetMap wheelchair routing wiki + OpenRouteService profile.
 *            wheelchair=yes|limited|no, kerb=flush|lowered|raised, smoothness tiers.
 * [AccessMap] UW Taskar Center AccessMap cost architecture. Hard filter slope >5%.
 * [Karimi16] Kasemsuppakorn & Karimi AHP framework: slope + surface + width dominate.
 * [Bennett09] Bennett et al. curb ramp 8-criterion survey; ramp slope compliance
 *             (1:12) most frequently failed criterion.
 *
 * Design decisions
 * ─────────────────
 * • Two separable sub-scores are produced:
 *   - nodeScore  : 0–100, per individual OSM node / facility
 *   - routeScore : 0–100, for a complete AccessibleRoute object
 *
 * • Tier hierarchy (from [CHI25] + [Scoping]):
 *   Tier 1 — Critical (curb ramps, stairs, elevation transitions)   ~40 pts
 *   Tier 2 — High     (surface, slope, path width)                  ~35 pts
 *   Tier 3 — Moderate (toilets, crossing signals, tactile paving)    ~15 pts
 *   Tier 4 — Minor    (shelter, bench, automatic door, lighting)     ~10 pts
 *
 * • Route-level split: accessibility 65% / travel-time 35%.
 *   Rationale: empirically observed that wheelchair users accept 14–74% longer
 *   detours to avoid barriers [Karimi16, Shanghai25]. Time is a real constraint
 *   but a secondary one.
 *
 * • Semantic score bands (0–100 → 5-star label):
 *   ≥80  Excellent  (★★★★★)
 *   60–79 Good      (★★★★☆)
 *   40–59 Fair      (★★★☆☆)
 *   20–39 Poor      (★★☆☆☆)
 *   <20  Critical   (★☆☆☆☆)
 */

import { IOsmA11y } from "../types";

// ─── Node-level scoring ───────────────────────────────────────────────────────

/**
 * Raw contribution table for individual OSM tag key→value pairs.
 *
 * Positive values indicate accessibility benefit.
 * Negative values indicate barrier presence.
 * Values are on a 0–100 scale before normalization.
 *
 * Tier 1 (Critical, total capacity ~40):
 *   Sources: [CHI25] curb ramps #1 barrier; [Scoping] ramps 63%, curb cuts 54%;
 *            [TW-MOI] elevator ≥90cm door, ramp max 1:12;
 *            [Huang25] facility type = 53.6% of variance.
 *
 * Tier 2 (High, total capacity ~35):
 *   Sources: [Choi15] slope physiology; [TW-MOI] cross slope ≤2%;
 *            [Karimi16] surface/slope dominate user AHP weights;
 *            [OSM-WC] smoothness taxonomy.
 *
 * Tier 3 (Moderate, total capacity ~15):
 *   Sources: [Scoping] crosswalks 50%; [TW-MOI] accessible toilet specs.
 *
 * Tier 4 (Minor, total capacity ~10):
 *   Sources: [CHI25] bench/shelter ranked low; [AccessMap] lighting secondary.
 */

type TagWeightMap = Record<string, Record<string, number>>;

// ── Tier 1 — Critical ─────────────────────────────────────────────────────────
// wheelchair tag: the primary OSM accessibility flag.
// yes=confirmed ADA/TW-compliant path [OSM-WC]: stepless entry, all rooms accessible.
// limited=step ≤7 cm (manageable, not ideal) [OSM-WC Wheelmap threshold].
// designated=purpose-built accessible facility.
// no=confirmed inaccessible: apply penalty because its presence near a route is a
//    signal that alternative paths exist in a non-accessible zone.
const TIER1_WEIGHTS: TagWeightMap = {
  wheelchair: {
    yes: 40,        // confirmed accessible [CHI25, OSM-WC]
    designated: 35, // purpose-built (e.g., wheelchair ramp or designated crossing)
    limited: 15,    // step ≤7 cm — usable with effort [OSM-WC, Wheelmap]
    no: -20,        // confirmed inaccessible — strong negative signal [CHI25]
  },
  // Elevator: binary high-value asset. Huang25: facility type = 53.6% variance.
  // elevator tag on a node means an actual vertical transport device.
  elevator: {
    yes: 38,
    wheelchair: 40, // dedicated wheelchair elevator is even better
  },
  // highway=elevator is an OSM node typed as elevator (not just a tag on a building).
  // highway=dropped_kerb is a lowered kerb — the canonical OSM tag for a curb cut.
  // [CHI25] missing curb ramps #1 barrier; [Bennett09] ramp slope most failed criterion.
  highway: {
    elevator: 38,
    dropped_kerb: 30, // flush curb cut — directly addresses the #1 ranked barrier
  },
  // Ramp with wheelchair designation — Tier 1 because ramps resolve steps.
  "ramp:wheelchair": {
    yes: 28, // confirmed wheelchair ramp present [TW-MOI, Scoping]
  },
  ramp: {
    yes: 22, // generic ramp (less certain it meets wheelchair specs)
  },
  // Kerb type — directly determines step-free transition at crossings.
  // flush > lowered >> raised. [TW-MOI] threshold ≤3 cm; [OSM-WC] ≤3 cm = limited passable.
  kerb: {
    flush: 28,    // exactly 0 cm — ideal [Bennett09, TW-MOI]
    lowered: 18,  // reduced height — passable for most wheelchairs [OSM-WC]
    no: 15,       // explicitly no kerb (same as flush in practice)
    raised: -15,  // step present — barrier [CHI25 #1 barrier type]
  },
};

// ── Tier 2 — High ─────────────────────────────────────────────────────────────
// Surface smoothness: the OSM smoothness tag follows an ordinal scale.
// [Karimi16] surface condition is one of two dominant user AHP factors.
// [Chen24] asphalt << permeable brick < granite in vibration; cobblestone = poor.
// [OSM-WC] wheelchair needs at minimum "intermediate" smoothness.
const TIER2_WEIGHTS: TagWeightMap = {
  smoothness: {
    excellent: 20,     // new asphalt/concrete — zero vibration
    good: 16,          // worn asphalt — minimal vibration
    intermediate: 10,  // lower limit for manual wheelchairs [OSM-WC]
    bad: -8,           // cobblestone/brick — significant vibration [Chen24]
    very_bad: -18,     // broken surface — dangerous [CHI25 uneven panels Tier 2]
    horrible: -25,     // impassable for most wheelchairs
    very_horrible: -30,
    impassable: -35,
  },
  // Surface material: proxy for roughness when smoothness tag absent.
  // [Chen24] Beijing IoT study: asphalt preferred, cobblestone worst.
  surface: {
    asphalt: 12,
    concrete: 10,
    paving_stones: 5,   // smooth pavers — acceptable
    sett: -5,           // rough sett stones
    cobblestone: -12,   // [Chen24] highest vibration
    gravel: -15,        // excluded by ORS wheelchair profile [OSM-WC]
    grass: -20,         // impassable for most wheelchairs
    sand: -20,
    mud: -25,
    dirt: -18,
  },
  // Path width: minimum thresholds from [TW-MOI] outdoor ≥130 cm, ramp ≥90 cm.
  // [UK-DfT] 1000 mm short sections, 1500 mm standard, 2000 mm bidirectional.
  // Encoded as ranges matching OSM width values (numeric meters).
  // Width is handled in the numeric helper below; these are tag-level hints.
  // (Actual numeric width scoring uses scoreWidth() separately.)
  "width:lanes": {}, // reserved — handled by scoreWidth()
};

// ── Tier 3 — Moderate ─────────────────────────────────────────────────────────
const TIER3_WEIGHTS: TagWeightMap = {
  // Accessible toilet — important for long journeys [TW-MOI, CHI25 Tier 3].
  "toilets:wheelchair": {
    yes: 12,
    designated: 12,
    limited: 5,
    no: 0, // absence not penalised (not everywhere has toilets)
  },
  // Crossing signals — audio + vibration support for combined mobility/visual needs.
  // [Scoping] crosswalks 50% of studies; [TW-MOI] audio signals required at intersections.
  "traffic_signals:sound": {
    yes: 8,
  },
  "traffic_signals:vibration": {
    yes: 5,
  },
  // Tactile paving — primarily benefits users with combined visual/mobility impairment.
  // [Scoping] present in TW-standard accessible routes [TW-MOI].
  tactile_paving: {
    yes: 8,
    no: 0,
  },
  // Crossing type — zebra + signals is significantly safer for wheelchair users
  // who need time and clear path [TW-MOI pedestrian crossing standards].
  crossing: {
    traffic_signals: 8,
    "marked;traffic_signals": 10,
    zebra: 6,
    marked: 4,
    uncontrolled: 0,
    unmarked: -2,
  },
  // Pedestrian arcade (騎樓) wheelchair accessibility — Taiwan-specific tag.
  "pedestrian arcade:wheelchair": {
    yes: 6,
    limited: 2,
    no: -4,
  },
};

// ── Tier 4 — Minor ────────────────────────────────────────────────────────────
// [CHI25]: shelter, bench ranked in lowest importance tier for wheelchair users.
// [AccessMap]: lighting is secondary after slope/surface/curb cuts.
const TIER4_WEIGHTS: TagWeightMap = {
  shelter: { yes: 4 },
  bench: { yes: 3 },
  automatic_door: { yes: 5 }, // slightly higher — reduces manual push effort
  door: {
    automatic: 5,
    sliding: 3,   // easier than hinged for wheelchair users
    hinged: 0,
  },
  lit: { yes: 3, "24/7": 4 },
  // Accessible parking space nearby — useful context for route endpoints.
  "capacity:disabled": {}, // numeric — handled separately if needed
};

// Merge all tiers into a single lookup (order determines priority — later overwrites).
const ALL_TAG_WEIGHTS: TagWeightMap = {
  ...TIER4_WEIGHTS,
  ...TIER3_WEIGHTS,
  ...TIER2_WEIGHTS,
  ...TIER1_WEIGHTS,
};

// ── Slope scoring ──────────────────────────────────────────────────────────────
/**
 * Convert a slope percentage (running grade) to a score contribution.
 *
 * Thresholds from [Choi15] biomechanical study + [TW-MOI] + [ADA PROWAG]:
 *   ≤5%   Preferred maximum (1:20) — ADA PAR, ISO 21542, UK DfT
 *   ≤8.33% Ramp maximum (1:12) — ADA, TW-MOI, Choi15 "acceptable"
 *   ≤10%  Short run maximum (1:10) — ADA alteration, Choi15 "marginal"
 *   ≤12.5% 1:8 — Choi15: high effort, BP elevation begins
 *   >12.5% Impassable without assistance [Choi15, Huang25]
 *
 * Returns a signed contribution (0 to -35) to be added to the node score.
 * Only negative (penalty) because slope is always a cost, never a benefit.
 */
export function slopeContribution(gradePercent: number): number {
  const g = Math.abs(gradePercent);
  if (g <= 5) return 0;         // preferred — no penalty
  if (g <= 8.33) return -8;     // acceptable ramp grade
  if (g <= 10) return -18;      // marginal [Choi15]
  if (g <= 12.5) return -28;    // difficult [Choi15 1:8]
  return -35;                   // near-impassable [Huang25 speed → 0]
}

// ── Width scoring ──────────────────────────────────────────────────────────────
/**
 * Convert a numeric path width in metres to a score contribution.
 *
 * Thresholds:
 *   <0.90 m  Impassable for wheelchair [TW-MOI ramp ≥90 cm, ORS ≥0.9 m]
 *   0.90–1.29 m  Tight — single wheelchair only, no passing [OSM-WC ≥0.9 m min]
 *   1.30–1.49 m  TW outdoor minimum (建築物無障礙設施設計規範 ≥130 cm)
 *   1.50–1.99 m  Standard — comfortable single direction [EU/UK standard]
 *   ≥2.00 m  Two wheelchairs passing [UK-DfT ≥2000 mm bidirectional]
 */
export function widthContribution(widthMetres: number): number {
  if (widthMetres < 0.9) return -30;   // below wheelchair minimum
  if (widthMetres < 1.3) return -10;   // tight, technically passable
  if (widthMetres < 1.5) return 0;     // meets TW minimum, no bonus/penalty
  if (widthMetres < 2.0) return 8;     // comfortable single direction
  return 15;                           // two wheelchair passing width
}

// ── Cross-slope scoring ────────────────────────────────────────────────────────
/**
 * Transverse (cross) slope penalty.
 * [ADA] ≤2.08% (1:48); [UK-DfT] ≤2.5%; [TW-MOI] ramp cross slope ≤2%.
 * [UK-DfT note]: >2.5% "impossible for many wheelchair users."
 */
export function crossSlopeContribution(crossSlopePercent: number): number {
  const g = Math.abs(crossSlopePercent);
  if (g <= 2.08) return 0;    // within ADA/TW standard
  if (g <= 2.5) return -5;    // UK borderline
  if (g <= 4) return -12;     // uncomfortable, drift risk
  return -20;                 // dangerous lateral drift
}

// ─── Node scorer ──────────────────────────────────────────────────────────────

/**
 * Maximum possible raw score before clamping.
 * Calculated as the sum of maximum Tier 1-4 positive contributions
 * for a single ideally-equipped node.
 * Elevator (38) + wheelchair=yes (40) are mutually exclusive in practice,
 * but we cap at a realistic maximum rather than the theoretical sum.
 *
 * Practical max: wheelchair=yes(40) + elevator=yes(38) + kerb=flush(28) +
 *   smoothness=excellent(20) + tactile_paving(8) + crossing(10) + shelter(4) +
 *   bench(3) + automatic_door(5) + lit(4) + toilets(12) + signals(13)  ≈ 185
 * We use 100 as denominator (scores > 100 raw → clamped to 100 output).
 */
const NODE_SCORE_DENOM = 100;

/**
 * Score a single OsmA11y node on a 0–100 scale.
 *
 * The score represents "how much this facility improves wheelchair accessibility
 * at this location." A node with confirmed elevator + flush kerb + accessible
 * toilet scores near 100.
 *
 * Category bonuses (from [Huang25] facility type = 53.6% of variance):
 *   elevator  → +15 base (independent of tags — its existence is the signal)
 *   kerb_cut  → +10 base
 *   ramp      → +8 base
 *   toilet    → +5 base
 *   wheelchair_accessible → 0 (tags carry the signal)
 */
export function scoreOsmNode(node: IOsmA11y): number {
  let raw = 0;

  // Category-level base bonus [Huang25]
  switch (node.category) {
    case "elevator":
      raw += 15;
      break;
    case "kerb_cut":
      raw += 10;
      break;
    case "ramp":
      raw += 8;
      break;
    case "toilet":
      raw += 5;
      break;
    default:
      break;
  }

  // Tag-level contributions
  const tags = node.tags ?? {};
  for (const [tagKey, valueMap] of Object.entries(ALL_TAG_WEIGHTS)) {
    const val = tags[tagKey];
    if (val === undefined) continue;
    const contribution = valueMap[val] ?? 0;
    raw += contribution;
  }

  // Numeric width tag
  const widthRaw = tags["width"];
  if (widthRaw) {
    const widthM = parseFloat(widthRaw);
    if (!isNaN(widthM)) raw += widthContribution(widthM);
  }

  // Numeric incline/slope tag — value may be "8%" or "8" or "-12%"
  const inclineRaw = tags["incline"];
  if (inclineRaw) {
    const cleaned = inclineRaw.replace("%", "").replace("°", "");
    const grade = parseFloat(cleaned);
    if (!isNaN(grade)) raw += slopeContribution(grade);
  }

  // Clamp to [0, NODE_SCORE_DENOM] then normalize to 0–100
  const clamped = Math.max(0, Math.min(raw, NODE_SCORE_DENOM));
  return (clamped / NODE_SCORE_DENOM) * 100;
}

// ─── Facility-set scorer ──────────────────────────────────────────────────────

/**
 * Score a collection of OSM nodes around a stop/station on 0–100.
 *
 * Strategy: use the MAX over nodes for Tier 1 critical features
 * (one elevator is enough to make a stop accessible), and AVERAGE for
 * general environment quality.
 *
 * This avoids double-counting: 5 elevator nodes near a station should
 * not score 5× better than 1.
 *
 * If the node set is empty, returns 0 (unknown = worst case for safety).
 */
export function scoreFacilitySet(nodes: IOsmA11y[]): number {
  if (!nodes.length) return 0;

  // Best single-node score (captures the strongest positive asset)
  const maxNodeScore = Math.max(...nodes.map(scoreOsmNode));

  // Average over all nodes (captures environment density)
  const avgNodeScore =
    nodes.reduce((sum, n) => sum + scoreOsmNode(n), 0) / nodes.length;

  // Tier 1 critical checks: does ANY node confirm an elevator or flush kerb?
  const hasElevator = nodes.some(
    (n) =>
      n.category === "elevator" ||
      n.tags?.["elevator"] === "yes" ||
      n.tags?.["highway"] === "elevator"
  );
  const hasFlushKerb = nodes.some(
    (n) =>
      n.category === "kerb_cut" ||
      n.tags?.["kerb"] === "flush" ||
      n.tags?.["kerb"] === "lowered" ||
      n.tags?.["highway"] === "dropped_kerb"
  );
  const hasRamp = nodes.some(
    (n) => n.category === "ramp" || n.tags?.["ramp:wheelchair"] === "yes"
  );
  const hasAccessibleToilet = nodes.some(
    (n) => n.tags?.["toilets:wheelchair"] === "yes"
  );

  // Combine: 60% from max node (asset quality), 40% from avg (environment density).
  // Then add binary bonuses for Tier 1 presence (up to +20 pts).
  let score = maxNodeScore * 0.6 + avgNodeScore * 0.4;

  // Binary infrastructure bonuses — capped to avoid over-inflation
  if (hasElevator) score = Math.min(score + 15, 95);    // [Huang25]: elevator = most impactful facility
  if (hasFlushKerb) score = Math.min(score + 8, 95);    // [CHI25]: #1 barrier addressed
  if (hasRamp) score = Math.min(score + 5, 95);         // [Scoping]: ramps 63% of studies
  if (hasAccessibleToilet) score = Math.min(score + 4, 95); // Tier 3 benefit

  return Math.min(score, 100);
}

// ─── Route-level scorer ───────────────────────────────────────────────────────

/**
 * Semantic labels for route scores.
 * Aligned to a 5-star system for client display.
 *
 * Thresholds:
 *  ≥80  Excellent — fully accessible, elevator + flush kerbs + good surface
 *  60–79 Good     — mostly accessible, minor gaps
 *  40–59 Fair     — accessible with effort, some barriers
 *  20–39 Poor     — significant barriers, consider alternatives
 *  <20   Critical — route likely impassable or very difficult
 */
export type ScoreLabel = "excellent" | "good" | "fair" | "poor" | "critical";

export function scoreLabel(score: number): ScoreLabel {
  if (score >= 80) return "excellent";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  if (score >= 20) return "poor";
  return "critical";
}

export interface RouteAccessibilityScore {
  /** Normalized 0–100 route-level accessibility score. */
  totalScore: number;
  /** Human-readable label. */
  label: ScoreLabel;
  /**
   * Component breakdown for debugging / client display.
   * All components are 0–100.
   */
  components: {
    /** Average a11y quality across all leg endpoints. */
    facilityScore: number;
    /** Normalized travel time score (100 = fastest candidate). */
    timeScore: number;
    /** Presence of Tier 1 critical features (elevator, flush kerb, ramp). */
    criticalFeatureScore: number;
  };
}

/**
 * Score an AccessibleRoute object.
 *
 * @param facilityNodes  All OSM a11y nodes from all legs (walk + transit endpoints).
 * @param totalMinutes   Total journey time in minutes.
 * @param maxMinutes     Maximum journey time among all candidates (for normalization).
 * @param highlightCount Number of generated accessibility highlight strings.
 *
 * Weight split: accessibility 65% / time 35%.
 *
 * Rationale for 65/35:
 *   - Wheelchair users accept 14–74% longer routes to avoid barriers
 *     [Karimi16: 14.64% longer; Shanghai25: 74% longer detour].
 *   - This implies barrier avoidance >> travel time in user preference.
 *   - However time is not irrelevant: battery range (powered WC), fatigue (manual WC).
 *   - 65/35 reflects the revealed preference evidence while keeping time meaningful.
 *
 * Sub-components of the accessibility score (65 points):
 *   Facility quality (scoreFacilitySet)      40 pts  [Huang25 facility type 53.6%]
 *   Critical feature presence (binary)       25 pts  [CHI25, Scoping]
 *   Note: highlights add up to 5 bonus pts within facility score (already factored in
 *   scoreFacilitySet via binary bonuses).
 */
export function scoreRoute(
  facilityNodes: IOsmA11y[],
  totalMinutes: number,
  maxMinutes: number,
  highlightCount: number
): RouteAccessibilityScore {
  // ── Facility quality component (0–100 → contributes 40 of 65 a11y pts) ───
  const facilityScore = scoreFacilitySet(facilityNodes);

  // ── Critical feature component (0–100 → contributes 25 of 65 a11y pts) ──
  // Binary checks for the most impactful Tier 1 features.
  // Each confirmed feature adds to the critical score.
  const hasElevator = facilityNodes.some(
    (n) =>
      n.category === "elevator" ||
      n.tags?.["elevator"] === "yes" ||
      n.tags?.["highway"] === "elevator"
  );
  const hasFlushKerb = facilityNodes.some(
    (n) =>
      n.category === "kerb_cut" ||
      n.tags?.["kerb"] === "flush" ||
      n.tags?.["kerb"] === "lowered" ||
      n.tags?.["highway"] === "dropped_kerb"
  );
  const hasRamp = facilityNodes.some(
    (n) => n.category === "ramp" || n.tags?.["ramp:wheelchair"] === "yes"
  );
  const hasAccessibleToilet = facilityNodes.some(
    (n) => n.tags?.["toilets:wheelchair"] === "yes"
  );
  const hasWheelchairYes = facilityNodes.some(
    (n) => n.tags?.["wheelchair"] === "yes"
  );
  const hasAudioSignal = facilityNodes.some(
    (n) => n.tags?.["traffic_signals:sound"] === "yes"
  );

  // Critical feature score: weighted sum of binary flags, normalized to 100.
  // Weights proportional to factor importance from literature.
  const criticalRaw =
    (hasElevator ? 35 : 0) +      // [Huang25] facility type most impactful
    (hasFlushKerb ? 30 : 0) +     // [CHI25] #1 barrier addressed
    (hasRamp ? 15 : 0) +          // [Scoping] ramps 63%
    (hasWheelchairYes ? 10 : 0) + // OSM confirmed accessible
    (hasAccessibleToilet ? 6 : 0) + // Tier 3
    (hasAudioSignal ? 4 : 0);       // Tier 3
  const criticalFeatureScore = Math.min(criticalRaw, 100);

  // ── Time component (0–100) ────────────────────────────────────────────────
  // Linear normalization: fastest route scores 100, longest scores ~0.
  // Using (1 - ratio) so faster = higher score.
  const timeScore = maxMinutes > 0
    ? Math.max(0, (1 - totalMinutes / maxMinutes) * 100)
    : 100;

  // ── Highlight bonus (up to +5 pts folded into facilityScore) ─────────────
  // Each highlight string is a confirmed accessibility feature; adds up to 5 pts.
  const highlightBonus = Math.min(highlightCount * 1.5, 5);
  const adjustedFacilityScore = Math.min(facilityScore + highlightBonus, 100);

  // ── Combine ───────────────────────────────────────────────────────────────
  // a11yScore = 40% facility + 25% critical (both contributing to 65% total weight)
  // Scaled so that a11y components together contribute 65 of 100 points.
  const a11yScore =
    adjustedFacilityScore * (40 / 65) + criticalFeatureScore * (25 / 65);

  const totalScore = Math.round(a11yScore * 0.65 + timeScore * 0.35);

  return {
    totalScore: Math.max(0, Math.min(100, totalScore)),
    label: scoreLabel(totalScore),
    components: {
      facilityScore: Math.round(adjustedFacilityScore),
      timeScore: Math.round(timeScore),
      criticalFeatureScore: Math.round(criticalFeatureScore),
    },
  };
}

// ─── Walk-leg surface penalty ─────────────────────────────────────────────────

/**
 * Derive a surface quality penalty for a walk leg based on the
 * aggregate OSM features along the leg.
 *
 * This is a lightweight heuristic: ORS already provides a wheelchair-
 * optimized route, but the OsmA11y nodes along the route give us a
 * local environment quality signal.
 *
 * Returns a multiplier [0.5, 1.0] applied to the walk leg's a11y score.
 * 1.0 = no penalty; 0.5 = severe surface degradation detected nearby.
 *
 * Sources: [Chen24] surface preference; [Karimi16] surface = dominant AHP factor.
 */
export function walkLegSurfaceMultiplier(nodes: IOsmA11y[]): number {
  if (!nodes.length) return 0.85; // unknown → conservative reduction

  const surfacePenalties = nodes
    .map((n) => {
      const smoothness = n.tags?.["smoothness"];
      const surface = n.tags?.["surface"];
      let penalty = 0;
      if (smoothness) {
        const w = (TIER2_WEIGHTS.smoothness ?? {})[smoothness] ?? 0;
        penalty += w < 0 ? Math.abs(w) : 0;
      }
      if (surface) {
        const w = (TIER2_WEIGHTS.surface ?? {})[surface] ?? 0;
        penalty += w < 0 ? Math.abs(w) : 0;
      }
      return penalty;
    });

  const maxPenalty = Math.max(...surfacePenalties, 0);
  // Map penalty 0→35 to multiplier 1.0→0.5
  const multiplier = 1.0 - (Math.min(maxPenalty, 35) / 35) * 0.5;
  return Math.round(multiplier * 100) / 100;
}
