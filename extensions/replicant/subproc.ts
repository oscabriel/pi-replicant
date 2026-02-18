import * as path from "node:path";
import {
   DEFAULT_MAX_BYTES,
   DEFAULT_MAX_LINES,
   DefaultResourceLoader,
   SessionManager,
   createAgentSession,
   createFindTool,
   createGrepTool,
   createLsTool,
   createReadTool,
   truncateHead,
   type ExtensionFactory,
} from "@mariozechner/pi-coding-agent";

const MAX_FINAL_TEXT_BYTES = DEFAULT_MAX_BYTES;
const MAX_FINAL_TEXT_LINES = DEFAULT_MAX_LINES;
const MAX_EVENTS_TO_KEEP = 120;
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_TOOL_CALLS = 40;

type ToolEvent = {
   type: "tool_start" | "tool_end";
   toolName: string;
   args?: unknown;
   isError?: boolean;
   timestamp: number;
};

export type ReplicantPhase = "booting" | "exploring" | "writing" | "done" | "error" | "aborted";

export interface ReplicantSubprocessDetails {
   phase: ReplicantPhase;
   message: string;
   toolCalls: number;
   toolErrors: number;
   turns: number;
   maxTurns: number;
   maxToolCalls: number;
   exitCode?: number;
   stopReason?: string;
   errorMessage?: string;
   stderrPreview?: string;
   truncation?: {
      stdoutOverflow: boolean;
      stderrOverflow: boolean;
      finalTextTruncated: boolean;
   };
   events: ToolEvent[];
}

export interface RunReplicantSubprocessOptions {
   cwd: string;
   systemPrompt: string;
   taskPrompt: string;
   tools: string[];
   model?: string;
   maxTurns?: number;
   maxToolCalls?: number;
   signal?: AbortSignal;
   scope?: {
      allowedRoots: string[];
      allowedFiles?: string[];
   };
   onUpdate?: (statusText: string, details: ReplicantSubprocessDetails) => void;
   sessionFactory?: ReplicantSessionFactory;
}

export interface ReplicantSubprocessResult {
   finalText: string;
   details: ReplicantSubprocessDetails;
}

export interface ReplicantSessionLike {
   prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
   subscribe(listener: (event: any) => void): () => void;
   abort(): Promise<void>;
   dispose(): void;
   state: { messages: any[] };
}

export interface ReplicantSessionFactoryInput {
   cwd: string;
   systemPrompt: string;
   tools: string[];
   model?: string;
   maxTurns: number;
   maxToolCalls: number;
   scope?: {
      allowedRoots: string[];
      allowedFiles?: string[];
   };
   signal?: AbortSignal;
   policyState: ReplicantPolicyState;
}

export type ReplicantSessionFactory = (input: ReplicantSessionFactoryInput) => Promise<ReplicantSessionLike>;

type ResolvedScope = {
   cwd: string;
   allowedRoots: string[];
   allowedFiles: string[];
};

type ReplicantPolicyState = {
   turnIndex: number;
   toolCalls: number;
   violation?: string;
   turnBudgetBlocked?: string;
};

export interface ToolCallPolicyInput {
   toolName: string;
   input: unknown;
   turnIndex: number;
   toolCalls: number;
   maxTurns: number;
   maxToolCalls: number;
   scope: ResolvedScope;
}

function normalizeToolPath(input: string): string {
   return input.trim().replace(/^@/, "");
}

function isWithinPath(targetPath: string, rootPath: string): boolean {
   const relative = path.relative(rootPath, targetPath);
   return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasUnsafeGlobSegments(pattern: string): boolean {
   const normalized = pattern.replace(/\\/g, "/").trim();
   if (!normalized) return false;
   if (path.isAbsolute(normalized)) return true;
   return normalized.split("/").some((segment) => segment === "..");
}

function extractAssistantText(message: any): string {
   if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
   const blocks: string[] = [];
   for (const part of message.content) {
      if (part?.type === "text" && typeof part.text === "string") blocks.push(part.text);
   }
   return blocks.join("");
}

function statusSummary(details: ReplicantSubprocessDetails): string {
   return `replicant ${details.phase}: tools=${details.toolCalls} errors=${details.toolErrors}`;
}

function resolveScope(cwd: string, scope?: { allowedRoots: string[]; allowedFiles?: string[] }): ResolvedScope {
   return {
      cwd,
      allowedRoots: (scope?.allowedRoots ?? []).map((root) => path.resolve(cwd, root)),
      allowedFiles: (scope?.allowedFiles ?? []).map((file) => path.resolve(cwd, file)),
   };
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
   return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

export function getToolCallPolicyViolation(options: ToolCallPolicyInput): string | undefined {
   const { toolName, input, turnIndex, toolCalls, maxTurns, maxToolCalls, scope } = options;

   if (turnIndex >= maxTurns - 1) {
      const humanTurn = Math.min(turnIndex + 1, maxTurns);
      return `Replicant subagent turn budget exceeded (${humanTurn}/${maxTurns}) before producing a final answer.`;
   }

   if (toolCalls >= maxToolCalls) {
      return `Replicant subagent tool call budget exceeded (${toolCalls}/${maxToolCalls}). Narrow the task for focused exploration.`;
   }

   if (!["read", "grep", "find", "ls"].includes(toolName)) return undefined;
   if (scope.allowedRoots.length === 0 && scope.allowedFiles.length === 0) return undefined;

   const toolInput = normalizeToolInput(input);
   const rawPath =
      typeof toolInput.path === "string"
         ? toolInput.path
         : typeof toolInput.file_path === "string"
            ? toolInput.file_path
            : ".";

   if (toolName === "find" && typeof toolInput.pattern === "string" && hasUnsafeGlobSegments(toolInput.pattern)) {
      return `Replicant subagent attempted out-of-scope find pattern: ${toolInput.pattern}. Parent-directory and absolute patterns are not allowed.`;
   }

   if (toolName === "grep" && typeof toolInput.glob === "string" && hasUnsafeGlobSegments(toolInput.glob)) {
      return `Replicant subagent attempted out-of-scope grep glob: ${toolInput.glob}. Parent-directory and absolute globs are not allowed.`;
   }

   const resolvedPath = path.resolve(scope.cwd, normalizeToolPath(rawPath));
   const allowedByRoot = scope.allowedRoots.some((root) => isWithinPath(resolvedPath, root));
   const allowedByFile = scope.allowedFiles.some((file) => resolvedPath === file);

   if (allowedByRoot || allowedByFile) return undefined;

   return `Replicant subagent attempted out-of-scope ${toolName} path: ${rawPath}. Allowed roots: ${scope.allowedRoots.join(", ")}. Allowed files: ${scope.allowedFiles.join(", ") || "(none)"}.`;
}

function createPolicyExtension(
   scope: ResolvedScope,
   maxTurns: number,
   maxToolCalls: number,
   policyState: ReplicantPolicyState,
): ExtensionFactory {
   return (pi) => {
      pi.on("turn_start", async (event) => {
         policyState.turnIndex = event.turnIndex;
      });

      pi.on("tool_call", async (event, ctx) => {
         const violation = getToolCallPolicyViolation({
            toolName: event.toolName,
            input: (event as { input?: unknown }).input,
            turnIndex: policyState.turnIndex,
            toolCalls: policyState.toolCalls,
            maxTurns,
            maxToolCalls,
            scope,
         });

         if (violation) {
            const blockedOnFinalTurn = policyState.turnIndex >= maxTurns - 1;
            if (blockedOnFinalTurn) {
               policyState.turnBudgetBlocked = policyState.turnBudgetBlocked ?? violation;
               return {
                  block: true,
                  reason: violation,
               };
            }
            policyState.violation = policyState.violation ?? violation;
            ctx.abort();
            return {
               block: true,
               reason: violation,
            };
         }

         policyState.toolCalls += 1;
         return undefined;
      });
   };
}

function parseModel(model?: string): { provider?: string; modelId: string } | undefined {
   if (!model) return undefined;
   const trimmed = model.trim();
   if (!trimmed) return undefined;

   const slash = trimmed.indexOf("/");
   if (slash === -1) {
      return { modelId: trimmed };
   }

   if (slash === 0 || slash === trimmed.length - 1) {
      throw new Error(`Invalid replicant model format: ${model}. Expected provider/model.`);
   }

   const provider = trimmed.slice(0, slash).trim();
   const modelId = trimmed.slice(slash + 1).trim();
   if (!provider || !modelId) {
      throw new Error(`Invalid replicant model format: ${model}. Expected provider/model.`);
   }
   return { provider, modelId };
}

function createReadOnlyToolsForSession(cwd: string, toolNames: string[]) {
   const selected: any[] = [];
   const seen = new Set<string>();

   for (const toolName of toolNames) {
      if (seen.has(toolName)) continue;
      seen.add(toolName);

      if (toolName === "read") {
         selected.push(createReadTool(cwd));
         continue;
      }

      if (toolName === "grep") {
         selected.push(createGrepTool(cwd));
         continue;
      }

      if (toolName === "find") {
         selected.push(createFindTool(cwd));
         continue;
      }

      if (toolName === "ls") {
         selected.push(createLsTool(cwd));
         continue;
      }

      throw new Error(`Replicant subagent requested unsupported tool: ${toolName}`);
   }

   return selected;
}

function getLastAssistantMessage(messages: any[]): any | undefined {
   for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "assistant") return message;
   }
   return undefined;
}

async function createDefaultSession(input: ReplicantSessionFactoryInput): Promise<ReplicantSessionLike> {
   const scope = resolveScope(input.cwd, input.scope);
   const resourceLoader = new DefaultResourceLoader({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [createPolicyExtension(scope, input.maxTurns, input.maxToolCalls, input.policyState)],
      systemPromptOverride: () => input.systemPrompt,
      skillsOverride: () => ({ skills: [], diagnostics: [] }),
   });

   await resourceLoader.reload();

   const { session } = await createAgentSession({
      cwd: input.cwd,
      resourceLoader,
      sessionManager: SessionManager.inMemory(input.cwd),
      tools: createReadOnlyToolsForSession(input.cwd, input.tools),
   });

   const requestedModel = parseModel(input.model);
   if (requestedModel) {
      const currentProvider = session.model?.provider;
      const provider = requestedModel.provider ?? currentProvider;
      const model = provider
         ? session.modelRegistry.find(provider, requestedModel.modelId)
         : session.modelRegistry.getAll().find((candidate) => candidate.id === requestedModel.modelId);
      if (!model) {
         session.dispose();
         throw new Error(`Replicant subagent model is not available: ${input.model}`);
      }
      await session.setModel(model);
   }

   return session as unknown as ReplicantSessionLike;
}

export async function runReplicantSubprocess(options: RunReplicantSubprocessOptions): Promise<ReplicantSubprocessResult> {
   const { cwd, systemPrompt, taskPrompt, tools, model, maxTurns, maxToolCalls, signal, scope, onUpdate, sessionFactory } = options;

   const effectiveMaxTurns =
      typeof maxTurns === "number" && Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : DEFAULT_MAX_TURNS;

   const effectiveMaxToolCalls =
      typeof maxToolCalls === "number" && Number.isFinite(maxToolCalls) && maxToolCalls > 0
         ? Math.floor(maxToolCalls)
         : DEFAULT_MAX_TOOL_CALLS;

   const details: ReplicantSubprocessDetails = {
      phase: "booting",
      message: "starting subagent",
      toolCalls: 0,
      toolErrors: 0,
      turns: 0,
      maxTurns: effectiveMaxTurns,
      maxToolCalls: effectiveMaxToolCalls,
      events: [],
      truncation: {
         stdoutOverflow: false,
         stderrOverflow: false,
         finalTextTruncated: false,
      },
   };

   const policyState: ReplicantPolicyState = {
      turnIndex: 0,
      toolCalls: 0,
   };

   let session: ReplicantSessionLike | undefined;
   let unsubscribe: (() => void) | undefined;
   let heartbeat: NodeJS.Timeout | undefined;
   let abortedBySignal = false;
   let finalText = "";

   const emit = (message: string) => {
      details.message = message;
      onUpdate?.(statusSummary(details), details);
   };

   const onAbort = () => {
      abortedBySignal = true;
      details.phase = "aborted";
      void session?.abort();
   };

   try {
      emit("booting in-process session");

      const factory = sessionFactory ?? createDefaultSession;
      session = await factory({
         cwd,
         systemPrompt,
         tools,
         model,
         maxTurns: effectiveMaxTurns,
         maxToolCalls: effectiveMaxToolCalls,
         scope,
         signal,
         policyState,
      });

      if (signal) {
         if (signal.aborted) onAbort();
         else signal.addEventListener("abort", onAbort, { once: true });
      }

      heartbeat = setInterval(() => {
         if (details.phase === "done" || details.phase === "error" || details.phase === "aborted") return;
         emit(details.phase === "exploring" ? "exploring codebase" : "waiting for output");
      }, 1500);

      unsubscribe = session.subscribe((event) => {
         if (event.type === "turn_end") {
            details.turns += 1;
            return;
         }

         if (event.type === "tool_execution_start") {
            details.phase = "exploring";
            details.toolCalls += 1;
            details.events.push({
               type: "tool_start",
               toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
               args: event.args,
               timestamp: Date.now(),
            });
            if (details.events.length > MAX_EVENTS_TO_KEEP) details.events.shift();
            emit(`running ${event.toolName ?? "unknown"}`);
            return;
         }

         if (event.type === "tool_execution_end") {
            details.phase = "exploring";
            if (event.isError) details.toolErrors += 1;
            details.events.push({
               type: "tool_end",
               toolName: typeof event.toolName === "string" ? event.toolName : "unknown",
               isError: Boolean(event.isError),
               timestamp: Date.now(),
            });
            if (details.events.length > MAX_EVENTS_TO_KEEP) details.events.shift();
            emit(event.isError ? `tool failed: ${event.toolName ?? "unknown"}` : `tool finished: ${event.toolName ?? "unknown"}`);
            return;
         }

         if (event.type === "message_update") {
            details.phase = "writing";
            emit("writing findings");
            return;
         }

         if (event.type === "message_end" && event.message?.role === "assistant") {
            const text = extractAssistantText(event.message);
            if (text) finalText = text;
            details.stopReason = typeof event.message.stopReason === "string" ? event.message.stopReason : details.stopReason;
            if (typeof event.message.errorMessage === "string" && event.message.errorMessage.trim()) {
               details.errorMessage = event.message.errorMessage.trim();
            }
            details.phase = "writing";
            emit("received assistant message");
         }
      });

      let promptError: Error | undefined;
      try {
         await session.prompt(taskPrompt, { expandPromptTemplates: false });
      } catch (error) {
         promptError = error instanceof Error ? error : new Error(String(error));
      }

      const lastAssistant = getLastAssistantMessage(session.state.messages ?? []);
      if (lastAssistant) {
         const text = extractAssistantText(lastAssistant);
         if (text) finalText = text;
         if (typeof lastAssistant.stopReason === "string") details.stopReason = lastAssistant.stopReason;
         if (typeof lastAssistant.errorMessage === "string" && lastAssistant.errorMessage.trim()) {
            details.errorMessage = lastAssistant.errorMessage.trim();
         }
      }

      if (policyState.violation) {
         details.phase = "error";
         details.errorMessage = policyState.violation;
         details.exitCode = 1;
         throw new Error(policyState.violation);
      }

      if (abortedBySignal) {
         details.phase = "aborted";
         details.exitCode = 1;
         throw new Error("Replicant subagent was aborted.");
      }

      if (promptError) {
         details.phase = "error";
         details.errorMessage = promptError.message;
         details.exitCode = 1;
         throw promptError;
      }

      if (!finalText.trim() && policyState.turnBudgetBlocked) {
         details.phase = "error";
         details.errorMessage = policyState.turnBudgetBlocked;
         details.exitCode = 1;
         throw new Error(policyState.turnBudgetBlocked);
      }

      if (details.stopReason === "error") {
         details.phase = "error";
         details.exitCode = 1;
         throw new Error(
            details.errorMessage
               ? `Replicant subagent reported stopReason=error: ${details.errorMessage}`
               : "Replicant subagent reported stopReason=error.",
         );
      }

      if (details.stopReason === "aborted") {
         details.phase = "aborted";
         details.exitCode = 1;
         throw new Error(
            details.errorMessage
               ? `Replicant subagent reported stopReason=aborted: ${details.errorMessage}`
               : "Replicant subagent reported stopReason=aborted.",
         );
      }

      const truncated = truncateHead(finalText || "(no output)", {
         maxBytes: MAX_FINAL_TEXT_BYTES,
         maxLines: MAX_FINAL_TEXT_LINES,
      });

      const finalOutput = truncated.truncated ? `${truncated.content}\n\n[replicant output truncated]` : truncated.content;
      details.truncation!.finalTextTruncated = truncated.truncated;
      details.phase = "done";
      details.exitCode = 0;
      emit("completed");

      return {
         finalText: finalOutput,
         details,
      };
   } finally {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      session?.dispose();
      if (signal) signal.removeEventListener("abort", onAbort);
   }
}
