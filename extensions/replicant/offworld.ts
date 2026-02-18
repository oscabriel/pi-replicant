import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type OwExecResult = {
   stdout: string;
   stderr: string;
   code: number;
   killed?: boolean;
};

type MapShowJson = {
   found: boolean;
   scope?: string;
   qualifiedName?: string;
   localPath?: string;
   primary?: string;
   referencePath?: string;
   keywords?: string[];
};

type MapSearchJson = Array<{
   qualifiedName: string;
   fullName: string;
   localPath: string;
   primary: string;
   keywords: string[];
   score: number;
}>;

export interface ResolveRepoOptions {
   pi: ExtensionAPI;
   ctx: ExtensionContext;
   signal?: AbortSignal;
   task: string;
   repoHint?: string;
   cwd?: string;
   onStatus?: (status: string) => void;
}

export interface ResolvedRepo {
   repo: string;
   qualifiedName: string;
   scope: string;
   clonePath: string;
   referencePath: string;
   resolvedFrom: "existing" | "pulled";
   searchCandidates: Array<{ repo: string; score: number }>;
}

export class ReplicantOffworldError extends Error {
   constructor(
      message: string,
      readonly code:
         | "ow_missing"
         | "repo_unresolved"
         | "repo_ambiguous"
         | "missing_assets"
         | "pull_rejected"
         | "pull_failed"
         | "invalid_map",
      readonly remediation?: string,
      readonly details?: Record<string, unknown>,
   ) {
      super(message);
   }
}

function parseJson<T>(raw: string, context: string): T {
   try {
      return JSON.parse(raw) as T;
   } catch {
      throw new ReplicantOffworldError(`Failed to parse JSON from ${context}.`, "invalid_map", undefined, {
         context,
         raw,
      });
   }
}

async function pathIsDir(path: string): Promise<boolean> {
   try {
      return (await fs.stat(path)).isDirectory();
   } catch {
      return false;
   }
}

async function pathIsFile(path: string): Promise<boolean> {
   try {
      return (await fs.stat(path)).isFile();
   } catch {
      return false;
   }
}

async function pathLooksLikeClone(repoPath: string): Promise<boolean> {
   if (!(await pathIsDir(repoPath))) return false;
   const gitMetadataPath = path.join(repoPath, ".git");
   try {
      const stat = await fs.stat(gitMetadataPath);
      return stat.isDirectory() || stat.isFile();
   } catch {
      return false;
   }
}


function toRepoSlug(entry: Pick<MapShowJson, "qualifiedName"> | Pick<MapSearchJson[number], "fullName">): string {
   if ("fullName" in entry) return entry.fullName;
   const q = entry.qualifiedName ?? "";
   if (q.includes(":")) return q.split(":")[1] ?? q;
   return q;
}

async function runOw(
   pi: ExtensionAPI,
   args: string[],
   signal?: AbortSignal,
   cwd?: string,
): Promise<OwExecResult> {
   const allowlist = new Set([
      "--version",
      "map show",
      "map search",
      "pull",
   ]);

   const head = args[0] === "--version" ? "--version" : args[0] === "pull" ? "pull" : args.slice(0, 2).join(" ");
   if (!allowlist.has(head)) {
      throw new ReplicantOffworldError(`Disallowed ow command: ow ${args.join(" ")}`, "invalid_map");
   }

   const result = (await pi.exec("ow", args, {
      signal,
      timeout: 20 * 60 * 1000,
      cwd,
   })) as OwExecResult;

   return result;
}

async function ensureOwInstalled(
   pi: ExtensionAPI,
   signal?: AbortSignal,
   cwd?: string,
) {
   const result = await runOw(pi, ["--version"], signal, cwd);
   if (result.code !== 0) {
      throw new ReplicantOffworldError(
         "Offworld CLI (`ow`) is not available.",
         "ow_missing",
         "Install Offworld: curl -fsSL https://offworld.sh/install | bash",
         { stderr: result.stderr, stdout: result.stdout, code: result.code },
      );
   }
}

async function mapShow(
   pi: ExtensionAPI,
   repo: string,
   signal?: AbortSignal,
   cwd?: string,
): Promise<MapShowJson> {
   const result = await runOw(pi, ["map", "show", repo, "--json"], signal, cwd);
   if (result.code !== 0) {
      throw new ReplicantOffworldError(
         `Failed to run ow map show ${repo} --json.`,
         "invalid_map",
         undefined,
         { stderr: result.stderr, stdout: result.stdout, code: result.code },
      );
   }
   return parseJson<MapShowJson>(result.stdout, `ow map show ${repo} --json`);
}

async function mapSearch(
   pi: ExtensionAPI,
   term: string,
   signal?: AbortSignal,
   cwd?: string,
): Promise<MapSearchJson> {
   const result = await runOw(pi, ["map", "search", term, "--json"], signal, cwd);
   if (result.code !== 0) {
      throw new ReplicantOffworldError(
         `Failed to run ow map search ${term} --json.`,
         "invalid_map",
         undefined,
         { stderr: result.stderr, stdout: result.stdout, code: result.code },
      );
   }
   return parseJson<MapSearchJson>(result.stdout, `ow map search ${term} --json`);
}

function extractSearchTerm(task: string): string {
   return task
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 120);
}

const PATH_LIKE_OWNER_DENYLIST = new Set([
   "src",
   "docs",
   "doc",
   "packages",
   "package",
   "examples",
   "example",
   "test",
   "tests",
   "lib",
   "dist",
   "scripts",
   "extensions",
   "apps",
   "app",
   "server",
   "client",
]);

function extractRepoHintFromTask(task: string): string | undefined {
   const githubMatch = task.match(/(?:https?:\/\/github\.com\/|github\.com[:/])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?/i);
   if (githubMatch?.[1]) return githubMatch[1];

   const tokenPattern = /(?:^|[\s`"'([])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\.git)?(?=$|[\s`"')\].,;:!?])/g;
   for (const match of task.matchAll(tokenPattern)) {
      const candidate = match[1];
      if (!candidate) continue;
      const [owner, repo] = candidate.split("/");
      if (!owner || !repo) continue;
      if (PATH_LIKE_OWNER_DENYLIST.has(owner.toLowerCase())) continue;
      if (/\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|yaml|yml|toml|rs|go|py|java|kt|swift|css|scss|html)$/i.test(repo)) continue;
      return candidate;
   }

   return undefined;
}


async function selectCandidate(
   ctx: ExtensionContext,
   candidates: MapSearchJson,
): Promise<MapSearchJson[number]> {
   if (candidates.length === 1) return candidates[0];
   const max = Math.min(6, candidates.length);
   const top = candidates.slice(0, max);
   if (ctx.hasUI) {
      const options = top.map((c) => ({
         label: `${c.fullName} (score ${c.score})`,
         candidate: c,
      }));
      const picked = await ctx.ui.select(
         "Choose repository for replicant",
         options.map((option) => option.label),
      );
      if (!picked) {
         throw new ReplicantOffworldError(
            "Repository selection canceled.",
            "repo_unresolved",
            "Re-run with an explicit `repo` value.",
         );
      }
      const pickedOption = options.find((option) => option.label === picked);
      if (pickedOption) return pickedOption.candidate;
      const pickedRepo = picked.replace(/\s+\(score [^)]+\)\s*$/, "");
      const matched = top.find((c) => c.fullName === pickedRepo);
      if (matched) return matched;
      throw new ReplicantOffworldError(
         "Repository selection did not match available candidates.",
         "repo_ambiguous",
         "Re-run with an explicit `repo` value.",
         {
            picked,
            candidates: top.map((c) => ({ repo: c.fullName, score: c.score })),
         },
      );
   }

   throw new ReplicantOffworldError(
      "Multiple Offworld map matches found; repository is ambiguous in non-interactive mode.",
      "repo_ambiguous",
      "Re-run with an explicit `repo` value (e.g. `repo: \"owner/repo\"`).",
      {
         candidates: top.map((c) => ({ repo: c.fullName, score: c.score })),
      },
   );
}

function buildPullArgs(repo: string): string[] {
   return ["pull", repo, "--clone-only"];
}

function formatOwCommand(args: string[]): string {
   return `ow ${args.join(" ")}`;
}


async function pullRepo(
   pi: ExtensionAPI,
   repo: string,
   signal?: AbortSignal,
   cwd?: string,
): Promise<void> {
   const pullArgs = buildPullArgs(repo);
   const pullCommand = formatOwCommand(pullArgs);
   const result = await runOw(pi, pullArgs, signal, cwd);
   if (result.code !== 0) {
      throw new ReplicantOffworldError(
         `Failed to pull ${repo}.`,
         "pull_failed",
         `Run manually: ${pullCommand}`,
         { stdout: result.stdout, stderr: result.stderr, code: result.code, command: pullCommand },
      );
   }
}

export async function resolveRepoWithOffworld(options: ResolveRepoOptions): Promise<ResolvedRepo> {
   const { pi, ctx, signal, task, repoHint, cwd, onStatus } = options;

   onStatus?.("checking-offworld");
   await ensureOwInstalled(pi, signal, cwd);

   let selectedRepo = repoHint ?? extractRepoHintFromTask(task);
   let searchCandidates: Array<{ repo: string; score: number }> = [];

   if (!selectedRepo) {
      onStatus?.("searching-map");
      const term = extractSearchTerm(task);
      const matches = await mapSearch(pi, term, signal, cwd);
      searchCandidates = matches.map((m) => ({ repo: m.fullName, score: m.score }));

      if (matches.length === 0) {
         throw new ReplicantOffworldError(
            "No Offworld map matches found for this task.",
            "repo_unresolved",
            "Pull a repository first, e.g. `ow pull owner/repo --clone-only`, then retry with `repo: \"owner/repo\"`.",
         );
      }

      const selected = await selectCandidate(ctx, matches);
      selectedRepo = selected.fullName;
   }

   if (!selectedRepo) {
      throw new ReplicantOffworldError("Repository could not be determined.", "repo_unresolved");
   }

   onStatus?.("resolving-map-entry");
   let show = await mapShow(pi, selectedRepo, signal, cwd);
   if (!show.found) {
      throw new ReplicantOffworldError(
         `Repository not found in Offworld map: ${selectedRepo}`,
         "repo_unresolved",
         `Run: ow pull ${selectedRepo} --clone-only`,
         { selectedRepo },
      );
   }

   const effectiveRepo = toRepoSlug(show);

   const hasClone = Boolean(show.localPath && (await pathLooksLikeClone(show.localPath)));
   const missingAssets = !hasClone;
   let resolvedFrom: "existing" | "pulled" = "existing";
   if (missingAssets) {
      if (ctx.hasUI) {
         const ok = await ctx.ui.confirm(
            "Pull repository with Offworld?",
            `Replicant needs a local clone for ${effectiveRepo}. Run ow pull ${effectiveRepo} --clone-only now?`,
         );
         if (!ok) {
            throw new ReplicantOffworldError(
               `Pull canceled for ${effectiveRepo}.`,
               "pull_rejected",
               `Run manually: ow pull ${effectiveRepo} --clone-only`,
            );
         }
      }
      const missingAssetPullCommand = formatOwCommand(buildPullArgs(effectiveRepo));
      onStatus?.(`pulling-repo (${missingAssetPullCommand})`);
      await pullRepo(pi, effectiveRepo, signal, cwd);
      resolvedFrom = "pulled";
      onStatus?.("re-resolving-map-entry");
      show = await mapShow(pi, effectiveRepo, signal, cwd);
   }
   const clonePath = show.localPath ?? "";
   const referencePath = show.referencePath ?? "";
   const cloneOk = clonePath.length > 0 && (await pathLooksLikeClone(clonePath));
   const referenceOk =
      referencePath.length > 0 &&
      !referencePath.endsWith("/") &&
      !referencePath.endsWith("\\") &&
      (await pathIsFile(referencePath));
   const resolvedReferencePath = referenceOk ? referencePath : "";
   if (!cloneOk) {
      throw new ReplicantOffworldError(
         `Offworld map entry is incomplete after resolution for ${effectiveRepo}. clone=${cloneOk}`,
         "missing_assets",
         `Run: ow pull ${effectiveRepo} --clone-only`,
         { map: show, cloneOk, referenceOk },
      );
   }
   return {
      repo: effectiveRepo,
      qualifiedName: show.qualifiedName ?? `github.com:${effectiveRepo}`,
      scope: show.scope ?? "unknown",
      clonePath,
      referencePath: resolvedReferencePath,
      resolvedFrom,
      searchCandidates,
   };
}
