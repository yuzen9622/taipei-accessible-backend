/**
 * Offline tool-routing eval. Runs each labeled case through the REAL routing
 * path (`routeOnce` → same `buildRoutingConfig` + `buildGeminiTools` as
 * production) and scores whether the expected tool fired. Does NOT execute any
 * tool and never touches MongoDB. Calls the real Gemini API, so it runs as a
 * standalone script (never under `npm test`).
 *
 * Run: `npm run eval:routing`   (EVAL_RUNS=N to change runs-per-case, default 3)
 */
import fs from "fs";
import path from "path";
import { model } from "../config/ai";
import { CHAT_SYSTEM_PROMPT, withUserLocation } from "../config/ai/chat-prompt";
import { routeOnce } from "../modules/ai/ai-chat.service";
import { agentCases, type AgentCase } from "./agent-cases";

const N = Number(process.env.EVAL_RUNS ?? 3);
const NONE = "__none__";

type Verdict = "PASS" | "FLAKY" | "FAIL" | "ERROR";

interface Outcome {
  id: string;
  query: string;
  expectTool: string;
  runs: string[][];
  errors: number;
  passes: number;
  verdict: Verdict;
}

function gradeRun(c: AgentCase, called: string[]): boolean {
  if (c.expectTool === NONE) return called.length === 0;
  const accept = new Set([c.expectTool, ...(c.acceptAlso ?? [])]);
  const hit = called.some((t) => accept.has(t));
  const forbidden = (c.mustNotCall ?? []).some((t) => called.includes(t));
  return hit && !forbidden;
}

async function evalCase(c: AgentCase): Promise<Outcome> {
  const sys = withUserLocation(CHAT_SYSTEM_PROMPT, c.userLocation);
  const userId = c.loggedIn ? "eval-user" : undefined; // only toggles tool catalogue; never hits DB
  const runs: string[][] = [];
  let errors = 0;

  for (let i = 0; i < N; i++) {
    try {
      const { calledTools } = await routeOnce(c.query, sys, {
        userLocation: c.userLocation,
        userId,
      });
      runs.push(calledTools);
    } catch (e: any) {
      errors++;
      runs.push([`__error__:${e?.message ?? "unknown"}`]);
    }
  }

  const passes = runs.filter((r) => gradeRun(c, r)).length;
  let verdict: Verdict;
  if (errors === N) verdict = "ERROR";
  else if (passes === N) verdict = "PASS";
  else if (passes === 0) verdict = "FAIL";
  else verdict = "FLAKY";

  return { id: c.id, query: c.query, expectTool: c.expectTool, runs, errors, passes, verdict };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  if (!process.env.GEMINI_API_KEY) {
    console.error(
      "GEMINI_API_KEY is required. Run via `npm run eval:routing` (loads .env via dotenvx).",
    );
    process.exit(1);
  }

  console.log(`Tool-Routing Eval  (model=${model}, N=${N}, ${agentCases.length} cases)`);
  console.log("=".repeat(76));

  const outcomes: Outcome[] = [];
  for (const c of agentCases) {
    const o = await evalCase(c);
    outcomes.push(o);
    const got = o.verdict === "PASS" ? "" : `  got: ${JSON.stringify(o.runs)}`;
    console.log(`${pad(o.verdict, 5)} ${pad(o.id, 16)} ${pad(o.expectTool, 24)} ${o.passes}/${N}${got}`);
  }

  const total = outcomes.length;
  const strictPass = outcomes.filter((o) => o.verdict === "PASS").length;
  const lenientPass = outcomes.reduce((s, o) => s + o.passes, 0);
  const fails = outcomes.filter((o) => o.verdict === "FAIL");
  const flaky = outcomes.filter((o) => o.verdict === "FLAKY");
  const errs = outcomes.filter((o) => o.verdict === "ERROR");

  console.log("-".repeat(76));
  console.log(`Strict accuracy : ${strictPass}/${total}  (${((strictPass / total) * 100).toFixed(1)}%)`);
  console.log(`Lenient accuracy: ${lenientPass}/${total * N}  (${((lenientPass / (total * N)) * 100).toFixed(1)}%)`);
  console.log(`FAIL: ${fails.length}   FLAKY: ${flaky.length}   ERROR: ${errs.length}`);
  if (fails.length || errs.length) {
    console.log("Mis-routes / errors:");
    for (const o of [...fails, ...errs]) {
      console.log(`  - ${o.id}: expected ${o.expectTool}, got ${JSON.stringify(o.runs)}`);
    }
  }

  const outDir = path.resolve(__dirname, "eval-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    timestamp: new Date().toISOString(),
    model,
    runs: N,
    strict: { pass: strictPass, total, accuracy: strictPass / total },
    lenient: { pass: lenientPass, total: total * N, accuracy: lenientPass / (total * N) },
    cases: outcomes,
  };
  const stamp = report.timestamp.replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(outDir, `routing-${stamp}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(report, null, 2));
  console.log(`\nReport: src/scripts/eval-reports/routing-${stamp}.json (+ latest.json)`);

  process.exit(fails.length + errs.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
