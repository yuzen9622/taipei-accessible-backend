/**
 * Action executor: owns the forced-step state machine. It runs each step by
 * calling the injected tool executor directly with registry-built args (the
 * model never selects tools or fills args here), normalizes every result,
 * enforces the "no dependent step after a failure" rule, and produces the final
 * speech via an injected NONE/text-only summarizer. Surface-neutral: no
 * `modules/line/*` imports.
 */
import { normalizeToolResult } from "./action-registry";
import type {
  ActionCtx,
  ActionExecOutcome,
  ActionSpec,
  ToolResultEntry,
} from "./agent-intent.types";

/** Dependencies injected by the calling surface (LINE binds userId/location). */
export interface ActionExecDeps {
  /** Runs a tool by name, returning its raw JSON string (as AgentToolExecutor). */
  execTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** NONE/text-only summarizer: builds speech from seed parts, calls no tools. */
  summarize: (seedParts: string[]) => Promise<string>;
}

function deterministicFallbackSpeech(toolResults: ToolResultEntry[]): string {
  if (toolResults.length === 0) {
    return "抱歉，目前無法完成這個查詢，請稍後再試。";
  }
  const allFailed = toolResults.every((entry) => entry.result.ok === false);
  if (allFailed) {
    return "抱歉，目前查不到相關資訊，請稍後再試。";
  }
  return "已為您完成查詢，請參考以上結果。";
}

/**
 * Run an action's forced steps and produce its outcome.
 *
 * @param spec The ActionSpec from the registry.
 * @param ctx Mutable execution context (slots/location/prev).
 * @param deps Injected tool executor + summarizer.
 * @returns A speech (+toolResults), a canned message, or a clarify request.
 */
export async function executeAction(
  spec: ActionSpec,
  ctx: ActionCtx,
  deps: ActionExecDeps,
): Promise<ActionExecOutcome> {
  const toolResults: ToolResultEntry[] = [];
  let index = 0;

  while (index < spec.steps.length) {
    const step = spec.steps[index];
    const args = step.buildArgs(ctx);

    let raw: string;
    try {
      raw = await deps.execTool(step.name, args);
    } catch {
      raw = JSON.stringify({ ok: false, errorCode: "TOOL_EXEC_ERROR" });
    }
    const result = normalizeToolResult(raw);
    ctx.prev.push(result);
    toolResults.push({ name: step.name, args, result });

    const outcome = step.onResult(result, ctx);
    if (outcome.kind === "stop_canned") {
      return { kind: "canned", speech: outcome.message };
    }
    if (outcome.kind === "clarify") {
      return {
        kind: "clarify",
        message: outcome.message,
        persist: outcome.persist,
      };
    }
    if (outcome.kind === "stop_success") {
      break;
    }
    if (outcome.kind === "fallback") {
      index = outcome.toStepIndex;
      continue;
    }
    // continue: hard rule — never run a dependent step after a failure.
    if (result.ok === false) break;
    index += 1;
  }

  const seedParts = toolResults.map(
    (entry) => `[工具 ${entry.name} 結果] ${JSON.stringify(entry.result)}`,
  );
  let speech: string;
  try {
    speech = await deps.summarize(seedParts);
    if (!speech.trim()) speech = deterministicFallbackSpeech(toolResults);
  } catch {
    speech = deterministicFallbackSpeech(toolResults);
  }
  return { kind: "speech", speech, toolResults };
}
