import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { ReplicantOffworldError, resolveRepoWithOffworld, type ResolvedRepo } from "./offworld";
import {
   ReplicantParamsSchema,
   MAX_CWD_LENGTH,
   MAX_REPO_LENGTH,
   MAX_TASK_LENGTH,
   assertNoControlChars,
   normalizeRepoHint,
   type ReplicantParams,
} from "./schemas";
import { runReplicantSubprocess, type ReplicantSubprocessDetails } from "./subproc";

type AgentDefinition = {
   name: string;
   description: string;
   model?: string;
   tools: string[];
   systemPrompt: string;
};

type ReplicantToolDetails = {
   status: "running" | "done" | "error";
   repo?: string;
   qualifiedName?: string;
   scope?: string;
   clonePath?: string;
   referencePath?: string;
   resolvedFrom?: "existing" | "pulled";
   searchCandidates?: Array<{ repo: string; score: number }>;
   phase?: ReplicantSubprocessDetails["phase"];
   subprocess?: ReplicantSubprocessDetails;
   remediation?: string;
};

const DEFAULT_AGENT: AgentDefinition = {
   name: "replicant",
   description: "Offworld-powered codebase exploration specialist",
   model: "claude-sonnet-4-5",
   tools: ["read", "grep", "find", "ls"],
   systemPrompt: [
      "You are a reconnaissance specialist for external repositories resolved by Offworld.",
      "",
      "Use the provided referencePath and clonePath as primary context.",
      "Prefer evidence from source files in the resolved clone and cite concrete line ranges.",
      "",
      "Return a direct answer to the task instead of filling a fixed template.",
      "Cite file paths with line ranges for concrete code claims.",
      "If evidence is partial, state uncertainty briefly and continue with the best-supported answer.",
      "Use short bullets only when they improve clarity; otherwise respond in compact prose.",
      "",
      "Constraints:",
      "- No edits; reconnaissance only.",
      "- Do not claim facts without file-level evidence.",
      "- Keep output concise, dense, and implementation-oriented.",
   ].join("\n"),
};
const RECON_TOOLS = ["read", "grep", "find", "ls"] as const;
const MAX_TURNS = 10;
const MAX_TOOL_CALLS = 60;

function toolsForAgent(agent: AgentDefinition): string[] {
   const selected = RECON_TOOLS.filter((tool) => agent.tools.includes(tool));
   return selected.length > 0 ? [...selected] : ["read", "grep", "find", "ls"];
}

function buildSubprocessSystemPrompt(basePrompt: string, tools: string[], maxTurns: number, maxToolCalls: number): string {
   return [
      basePrompt,
      "",
      "Execution policy:",
      `- Available tools: ${tools.join(", ")}`,
      "- Read referencePath first before broad source exploration.",
      "- Prefer targeted grep/ls reads over wide scans.",
      "- Stop as soon as you can answer with concrete evidence.",
      `- Hard budget: at most ${maxTurns} turns and ${maxToolCalls} tool calls.`,
      "- If evidence is insufficient, report uncertainty instead of over-searching.",
   ].join("\n");
}


function buildTaskPrompt(task: string, repo: ResolvedRepo, maxTurns: number, maxToolCalls: number): string {
   return [
      "Task:",
      task,
      "",
      "Resolved repository metadata:",
      `- repo: ${repo.repo}`,
      `- qualifiedName: ${repo.qualifiedName}`,
      `- scope: ${repo.scope}`,
      `- resolvedFrom: ${repo.resolvedFrom}`,
      `- referencePath: ${repo.referencePath}`,
      `- clonePath: ${repo.clonePath}`,
      "",
      "Requirements:",
      "- Read referencePath first, then inspect clonePath only as needed.",
      "- Use only the paths above as sources of truth.",
      "- Cite file paths with line ranges for all concrete code claims.",
      "- Distinguish observed facts from assumptions.",
      `- Stay within budget: max ${maxTurns} turns and ${maxToolCalls} tool calls.`,
      "- Stop searching once you have enough evidence to answer.",
      "- Keep output concise but actionable for implementation handoff."
   ].join("\n");
}


function validateParams(params: ReplicantParams): ReplicantParams {
   if (params.task.length > MAX_TASK_LENGTH) {
      throw new Error(`Invalid task: max length is ${MAX_TASK_LENGTH}.`);
   }

   if (params.repo && params.repo.length > MAX_REPO_LENGTH) {
      throw new Error(`Invalid repo: max length is ${MAX_REPO_LENGTH}.`);
   }

   if (params.cwd && params.cwd.length > MAX_CWD_LENGTH) {
      throw new Error(`Invalid cwd: max length is ${MAX_CWD_LENGTH}.`);
   }

   assertNoControlChars(params.task, "task");
   if (params.repo) assertNoControlChars(params.repo, "repo");
   if (params.cwd) assertNoControlChars(params.cwd, "cwd");

   return params;
}

function modelFromContext(ctx: ExtensionContext): string | undefined {
   const provider = typeof ctx.model?.provider === "string" ? ctx.model.provider.trim() : "";
   const modelId = typeof ctx.model?.id === "string" ? ctx.model.id.trim() : "";
   if (!provider || !modelId) return undefined;
   return `${provider}/${modelId}`;
}

function modelForRecon(hostModel?: string, agentModel?: string): string | undefined {
   return hostModel ?? agentModel ?? "claude-sonnet-4-5";
}

function toRepoRelativeDisplayPath(rawPath: string, repoRoot?: string): string {
   if (!repoRoot) return rawPath;
   const absoluteRoot = path.resolve(repoRoot);
   const absolutePath = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(absoluteRoot, rawPath);
   const relative = path.relative(absoluteRoot, absolutePath);
   if (relative === "") return ".";
   if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative.replace(/\\/g, "/");
   return rawPath;
}

function toOffworldReferenceDisplayPath(rawPath: string, repoRoot?: string, referencePath?: string): string | undefined {
   if (!referencePath) return undefined;
   const absoluteReferencePath = path.resolve(referencePath);
   const absolutePath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : repoRoot
         ? path.resolve(repoRoot, rawPath)
         : path.resolve(rawPath);
   if (absolutePath !== absoluteReferencePath) return undefined;
   return `offworld/references/${path.basename(referencePath)}`;
}


function formatToolArgValue(value: unknown, key?: string, repoRoot?: string, referencePath?: string): string {
   if (typeof value === "string") {
      let normalized = value.replace(/\s+/g, " ").trim();
      if (normalized && (key === "path" || key === "file" || key === "file_path")) {
         normalized =
            toOffworldReferenceDisplayPath(normalized, repoRoot, referencePath) ?? toRepoRelativeDisplayPath(normalized, repoRoot);
      }
      if (!normalized) return "\"\"";
      return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
   }
   if (typeof value === "number" || typeof value === "boolean") return String(value);
   if (Array.isArray(value)) return `[${value.length}]`;
   if (value && typeof value === "object") return "{...}";
   return String(value);
}

function isPathLikeArgKey(key: string): boolean {
   return key === "path" || key === "file" || key === "file_path";
}
function summarizeToolArgs(args: unknown, repoRoot?: string, referencePath?: string): string {
   if (!args || typeof args !== "object") return "";
   const input = args as Record<string, unknown>;
   const preferredKeys = ["path", "file_path", "pattern", "glob", "query", "file", "url", "type", "offset", "limit"];
   const keys = preferredKeys.filter((key) => key in input);
   const selectedKeys = (keys.length > 0 ? keys : Object.keys(input)).slice(0, 3);
   return selectedKeys
      .map((key) => {
         const formatted = formatToolArgValue(input[key], key, repoRoot, referencePath);
         return isPathLikeArgKey(key) ? formatted : `${key}=${formatted}`;
      })
      .join(" ");
}
function formatToolCallLines(subprocess?: ReplicantSubprocessDetails, repoRoot?: string, referencePath?: string): string[] {
   if (!subprocess) return [];
   const toolStarts = subprocess.events.filter((event) => event.type === "tool_start");
   return toolStarts.map((event) => {
      const args = summarizeToolArgs(event.args, repoRoot, referencePath);
      return `${event.toolName}${args ? ` ${args}` : ""}`;
   });
}


export default function replicantExtension(pi: ExtensionAPI) {
   pi.registerTool({
      name: "replicant",
      label: "Replicant",
      description:
         "Offworld-powered reconnaissance subagent. Resolves repo clone/reference via `ow`, optionally pulls missing assets, then runs an isolated read-only subagent and returns evidence-heavy findings.",
      parameters: ReplicantParamsSchema,

      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
         let resolvedRepo: ResolvedRepo | undefined;
         let subprocessDetails: ReplicantSubprocessDetails | undefined;

         const emit = (statusText: string, details: ReplicantToolDetails) => {
            onUpdate?.({
               content: [{ type: "text", text: statusText }],
               details,
            });
         };

         try {
            const params = validateParams(rawParams as ReplicantParams);
            const maxTurns = MAX_TURNS;
            const maxToolCalls = MAX_TOOL_CALLS;

            const hostModel = modelFromContext(ctx);
            const agent = DEFAULT_AGENT;
            const normalizedRepoHint = normalizeRepoHint(params.repo);

            emit("replicant: resolving Offworld map", {
               status: "running",
               phase: "booting",
            });

            resolvedRepo = await resolveRepoWithOffworld({
               pi,
               ctx,
               signal,
               task: params.task,
               repoHint: normalizedRepoHint,
               cwd: params.cwd,
               onStatus: (phase) => {
                  emit(`replicant: ${phase}`, {
                     status: "running",
                     phase: "booting",
                     repo: resolvedRepo?.repo,
                     searchCandidates: resolvedRepo?.searchCandidates,
                  });
               },
            });

            const safeTools = toolsForAgent(agent);

            const subprocessScope = {
               allowedRoots: [resolvedRepo.clonePath],
               allowedFiles: resolvedRepo.referencePath ? [resolvedRepo.referencePath] : [],
            };

            const runResult = await runReplicantSubprocess({
               cwd: resolvedRepo.clonePath,
               systemPrompt: buildSubprocessSystemPrompt(agent.systemPrompt, safeTools, maxTurns, maxToolCalls),
               taskPrompt: buildTaskPrompt(params.task, resolvedRepo, maxTurns, maxToolCalls),
               tools: safeTools,
               model: modelForRecon(hostModel, agent.model),
               maxTurns,
               maxToolCalls,
               signal,
               scope: subprocessScope,
               onUpdate: (statusText, details) => {
                  subprocessDetails = details;
                  emit(statusText, {
                     status: "running",
                     repo: resolvedRepo?.repo,
                     qualifiedName: resolvedRepo?.qualifiedName,
                     scope: resolvedRepo?.scope,
                     clonePath: resolvedRepo?.clonePath,
                     referencePath: resolvedRepo?.referencePath,
                     resolvedFrom: resolvedRepo?.resolvedFrom,
                     searchCandidates: resolvedRepo?.searchCandidates,
                     phase: details.phase,
                     subprocess: details,
                  });
               },
            });

            subprocessDetails = runResult.details;

            return {
               content: [{ type: "text", text: runResult.finalText }],
               details: {
                  status: "done",
                  repo: resolvedRepo.repo,
                  qualifiedName: resolvedRepo.qualifiedName,
                  scope: resolvedRepo.scope,
                  clonePath: resolvedRepo.clonePath,
                  referencePath: resolvedRepo.referencePath,
                  resolvedFrom: resolvedRepo.resolvedFrom,
                  searchCandidates: resolvedRepo.searchCandidates,
                  phase: runResult.details.phase,
                  subprocess: runResult.details,
               } satisfies ReplicantToolDetails,
            };
         } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const remediation = error instanceof ReplicantOffworldError ? error.remediation : undefined;

            return {
               content: [{ type: "text", text: remediation ? `${message}\n\n${remediation}` : message }],
               details: {
                  status: "error",
                  repo: resolvedRepo?.repo,
                  qualifiedName: resolvedRepo?.qualifiedName,
                  scope: resolvedRepo?.scope,
                  clonePath: resolvedRepo?.clonePath,
                  referencePath: resolvedRepo?.referencePath,
                  resolvedFrom: resolvedRepo?.resolvedFrom,
                  searchCandidates: resolvedRepo?.searchCandidates,
                  phase: subprocessDetails?.phase ?? "error",
                  subprocess: subprocessDetails,
                  remediation,
               } satisfies ReplicantToolDetails,
               isError: true,
            };
         }
      },

      renderCall(args, theme) {
         const repo = typeof args.repo === "string" ? args.repo : "(auto)";
         const task = typeof args.task === "string" ? args.task.replace(/\s+/g, " ").trim() : "";
         const taskPreview = task.length > 90 ? `${task.slice(0, 90)}...` : task;
         const text = [
            `${theme.fg("toolTitle", theme.bold("replicant"))} ${theme.fg("accent", repo)}`,
            theme.fg("dim", taskPreview || "(no task)"),
         ].join("\n");
         return new Text(text, 0, 0);
      },

      renderResult(result, { expanded }, theme) {
         const details = result.details as ReplicantToolDetails | undefined;
         const content = result.content[0];
         const text = content?.type === "text" ? content.text : "(no output)";

         if (!details) {
            return new Text(text, 0, 0);
         }

         const icon =
            details.status === "done"
               ? theme.fg("success", "✓")
               : details.status === "error"
                  ? theme.fg("error", "✗")
                  : theme.fg("warning", "⏳");

         const header = `${icon} ${theme.fg("toolTitle", theme.bold("replicant"))} ${theme.fg("accent", details.repo ?? "(unknown repo)")}`;
         const paths = [
            details.referencePath ? `${theme.fg("muted", "ref:")} ${theme.fg("toolOutput", details.referencePath)}` : undefined,
            details.clonePath ? `${theme.fg("muted", "path:")} ${theme.fg("toolOutput", details.clonePath)}` : undefined,
         ].filter(Boolean) as string[];

         const toolCallLines = formatToolCallLines(details.subprocess, details.clonePath, details.referencePath);
         const shouldRenderStatusText = details.status !== "running" || !details.subprocess;

         if (!expanded) {
            const previewLines = text.split("\n");
            const collapsedStatusMaxLines = details.status === "done" && details.subprocess ? 4 : 12;
            const preview = previewLines.slice(0, collapsedStatusMaxLines).join("\n");
            const previewTruncated = previewLines.length > collapsedStatusMaxLines;
            const hideStatusPreview = details.status === "done" && details.subprocess;
            const collapsedLines = [header, ...paths];
            if (details.subprocess) {
               collapsedLines.push("", theme.fg("dim", `tool calls=${details.subprocess.toolCalls} errors=${details.subprocess.toolErrors}`));
               const visibleToolCalls = toolCallLines.slice(-8);
               if (toolCallLines.length > visibleToolCalls.length) {
                  collapsedLines.push(theme.fg("dim", `... ${toolCallLines.length - visibleToolCalls.length} earlier tool calls`));
               }
               for (const line of visibleToolCalls) collapsedLines.push(theme.fg("toolOutput", line));
            }
            if (shouldRenderStatusText) {
               collapsedLines.push("");
               if (hideStatusPreview) {
                  collapsedLines.push(theme.fg("dim", "[final output hidden in collapsed view — press ctrl+o to expand]"));
               } else {
                  collapsedLines.push(theme.fg("toolOutput", preview));
                  if (previewTruncated) {
                     collapsedLines.push(theme.fg("dim", "[truncated in collapsed view — press ctrl+o to expand]"));
                  }
               }
            }
            return new Text(collapsedLines.join("\n"), 0, 0);
         }

         const mdTheme = getMarkdownTheme();
         const container = new Container();
         container.addChild(new Text(header, 0, 0));
         for (const line of paths) container.addChild(new Text(line, 0, 0));

         if (details.subprocess) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `tool calls=${details.subprocess.toolCalls} errors=${details.subprocess.toolErrors}`), 0, 0));
            for (const line of toolCallLines) {
               container.addChild(new Text(theme.fg("toolOutput", line), 0, 0));
            }
         }

         if (shouldRenderStatusText) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(text, 0, 0, mdTheme));
         }
         return container;
      },
   });
}
