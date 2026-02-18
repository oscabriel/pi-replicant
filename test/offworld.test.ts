import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ReplicantOffworldError, resolveRepoWithOffworld } from "../extensions/replicant/offworld";

type ExecResult = { stdout: string; stderr: string; code: number };
type ExecImpl = (args: string[]) => Promise<ExecResult>;

function makeCtx(
   hasUI = false,
   selectImpl?: (title: string, options: string[]) => Promise<string | undefined>,
   confirmImpl?: (title: string, message: string) => Promise<boolean>,
) {
   return {
      hasUI,
      cwd: process.cwd(),
      ui: {
         confirm: confirmImpl ?? (async () => true),
         select: selectImpl ?? (async () => undefined),
      },
      model: undefined,
      modelRegistry: undefined,
      sessionManager: undefined,
      isIdle: () => true,
      abort: () => undefined,
      hasPendingMessages: () => false,
      shutdown: () => undefined,
      getContextUsage: () => undefined,
      compact: () => undefined,
      getSystemPrompt: () => "",
   } as any;
}

function makePi(execImpl: ExecImpl) {
   return {
      exec: async (_command: string, args: string[]) => execImpl(args),
   } as any;
}

function ok(stdout: string): ExecResult {
   return { stdout, stderr: "", code: 0 };
}

async function markClonePresent(clonePath: string): Promise<void> {
   await fs.mkdir(path.join(clonePath, ".git"), { recursive: true });
}


test("resolveRepoWithOffworld: interactive pull confirmation rejection surfaces pull_rejected", async (t) => {
   const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-replicant-offworld-"));
   t.after(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
   });
   const clonePath = path.join(tmpDir, "clone");
   await fs.mkdir(clonePath, { recursive: true });
   const repo = "example/missing-ref";
   const calls: string[] = [];
   const pi = makePi(async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "--version") return ok("offworld v0.3.8");
      if (key === `map show ${repo} --json`) {
         return ok(
            JSON.stringify({
               found: true,
               qualifiedName: `github.com:${repo}`,
               scope: "global",
               localPath: clonePath,
               referencePath: `${path.join(tmpDir, "references")}/`,
            }),
         );
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
   });
   await assert.rejects(
      () =>
         resolveRepoWithOffworld({
            pi,
            ctx: makeCtx(true, undefined, async () => false),
            task: "inspect api surface",
            repoHint: repo,
         }),
      (err: unknown) => {
         const offworldErr = err as ReplicantOffworldError;
         assert.equal(offworldErr.code, "pull_rejected");
         return true;
      },
   );
   assert.deepEqual(calls, ["--version", `map show ${repo} --json`]);
});

test("resolveRepoWithOffworld: uses --clone-only when clone is missing", async (t) => {
   const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-replicant-offworld-"));
   t.after(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
   });

   const clonePath = path.join(tmpDir, "clone");
   const referencePath = path.join(tmpDir, "reference.md");
   await fs.writeFile(referencePath, "# reference\n", "utf8");

   const repo = "default-anton/pi-librarian";
   const calls: string[] = [];

   const pi = makePi(async (args) => {
      const key = args.join(" ");
      calls.push(key);

      if (key === "--version") return ok("offworld v0.3.8");
      if (key === `map show ${repo} --json`) {
         return ok(
            JSON.stringify({
               found: true,
               qualifiedName: `github.com:${repo}`,
               scope: "global",
               localPath: clonePath,
               referencePath,
            }),
         );
      }
      if (key === `pull ${repo} --clone-only`) {
         await fs.mkdir(clonePath, { recursive: true });
         await markClonePresent(clonePath);
         return ok("pulled");
      }

      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
   });

   const resolved = await resolveRepoWithOffworld({
      pi,
      ctx: makeCtx(false),
      task: "inspect bootstrap policy",
      repoHint: repo,
   });

   assert.equal(resolved.repo, repo);
   assert.equal(resolved.resolvedFrom, "pulled");
   assert.equal(resolved.clonePath, clonePath);
   assert.deepEqual(calls, ["--version", `map show ${repo} --json`, `pull ${repo} --clone-only`, `map show ${repo} --json`]);
});


test("resolveRepoWithOffworld: does not pull when clone exists but reference is missing", async (t) => {
   const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-replicant-offworld-"));
   t.after(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
   });
   const clonePath = path.join(tmpDir, "clone");
   await fs.mkdir(clonePath, { recursive: true });
   await markClonePresent(clonePath);
   const repo = "default-anton/pi-librarian";
   const calls: string[] = [];
   const pi = makePi(async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "--version") return ok("offworld v0.3.8");
      if (key === `map show ${repo} --json`) {
         return ok(
            JSON.stringify({
               found: true,
               qualifiedName: `github.com:${repo}`,
               scope: "global",
               localPath: clonePath,
               referencePath: `${path.join(tmpDir, "references")}/`,
            }),
         );
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
   });
   const resolved = await resolveRepoWithOffworld({
      pi,
      ctx: makeCtx(false),
      task: "inspect bootstrap policy",
      repoHint: repo,
   });
   assert.equal(resolved.repo, repo);
   assert.equal(resolved.resolvedFrom, "existing");
   assert.equal(resolved.referencePath, "");
   assert.deepEqual(calls, ["--version", `map show ${repo} --json`]);
});


test("resolveRepoWithOffworld: infers repo from task owner/repo and skips map search", async (t) => {
   const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-replicant-offworld-"));
   t.after(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
   });

   const repo = "tanstack/pacer";
   const clonePath = path.join(tmpDir, "clone");
   const referencePath = path.join(tmpDir, "reference.md");
   await fs.mkdir(clonePath, { recursive: true });
   await markClonePresent(clonePath);
   await fs.writeFile(referencePath, "# reference\n", "utf8");

   const calls: string[] = [];
   const pi = makePi(async (args) => {
      const key = args.join(" ");
      calls.push(key);

      if (key === "--version") return ok("offworld v0.3.8");
      if (key === `map show ${repo} --json`) {
         return ok(
            JSON.stringify({
               found: true,
               qualifiedName: `github.com:${repo}`,
               scope: "global",
               localPath: clonePath,
               referencePath,
            }),
         );
      }

      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
   });

   const resolved = await resolveRepoWithOffworld({
      pi,
      ctx: makeCtx(false),
      task: "Use replicant to inspect tanstack/pacer and summarize the project.",
   });

   assert.equal(resolved.repo, repo);
   assert.deepEqual(calls, ["--version", `map show ${repo} --json`]);
});


test("resolveRepoWithOffworld: non-interactive repo search with multiple matches throws repo_ambiguous", async (t) => {
   const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-replicant-offworld-"));
   t.after(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
   });
   const clonePath = path.join(tmpDir, "clone");
   const referencePath = path.join(tmpDir, "reference.md");
   await fs.mkdir(clonePath, { recursive: true });
   await fs.writeFile(referencePath, "# reference\n", "utf8");
   const top = "badlogic/pi-mono";
   const fallback = "default-anton/pi-librarian";
   const calls: string[] = [];
   const pi = makePi(async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "--version") return ok("offworld v0.3.8");
      if (key.startsWith("map search ")) {
         return ok(
            JSON.stringify([
               {
                  qualifiedName: `github.com:${top}`,
                  fullName: top,
                  localPath: clonePath,
                  primary: "badlogic-pi-mono.md",
                  keywords: ["pi"],
                  score: 0.97,
               },
               {
                  qualifiedName: `github.com:${fallback}`,
                  fullName: fallback,
                  localPath: "/tmp/other",
                  primary: "default-anton-pi-librarian.md",
                  keywords: [],
                  score: 0.11,
               },
            ]),
         );
      }
      if (key === `map show ${top} --json`) {
         return ok(
            JSON.stringify({
               found: true,
               qualifiedName: `github.com:${top}`,
               scope: "global",
               localPath: clonePath,
               referencePath,
            }),
         );
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
   });
   await assert.rejects(
      () =>
         resolveRepoWithOffworld({
            pi,
            ctx: makeCtx(false),
            task: "trace subagent architecture",
         }),
      (err: unknown) => {
         const offworldErr = err as ReplicantOffworldError;
         assert.equal(offworldErr.code, "repo_ambiguous");
         return true;
      },
   );
   assert.deepEqual(calls, ["--version", "map search trace subagent architecture --json"]);
});


test("resolveRepoWithOffworld: interactive selection uses exact label match", async (t) => {
   const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-replicant-offworld-"));
   t.after(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
   });

   const selectedRepo = "acme/repo-tools";
   const prefixRepo = "acme/repo";
   const clonePath = path.join(tmpDir, "clone");
   const referencePath = path.join(tmpDir, "reference.md");
   await fs.mkdir(clonePath, { recursive: true });
   await markClonePresent(clonePath);
   await fs.writeFile(referencePath, "# reference\n", "utf8");

   const calls: string[] = [];
   const pi = makePi(async (args) => {
      const key = args.join(" ");
      calls.push(key);
      if (key === "--version") return ok("offworld v0.3.8");
      if (key.startsWith("map search ")) {
         return ok(
            JSON.stringify([
               {
                  qualifiedName: `github.com:${prefixRepo}`,
                  fullName: prefixRepo,
                  localPath: path.join(tmpDir, "prefix"),
                  primary: "acme-repo.md",
                  keywords: ["repo"],
                  score: 0.92,
               },
               {
                  qualifiedName: `github.com:${selectedRepo}`,
                  fullName: selectedRepo,
                  localPath: clonePath,
                  primary: "acme-repo-tools.md",
                  keywords: ["repo", "tools"],
                  score: 0.91,
               },
            ]),
         );
      }
      if (key === `map show ${selectedRepo} --json`) {
         return ok(
            JSON.stringify({
               found: true,
               qualifiedName: `github.com:${selectedRepo}`,
               scope: "global",
               localPath: clonePath,
               referencePath,
            }),
         );
      }
      return { code: 1, stdout: "", stderr: `unexpected command: ${key}` };
   });

   const resolved = await resolveRepoWithOffworld({
      pi,
      ctx: makeCtx(true, async (_title, options) => options[1]),
      task: "trace repository tooling",
   });

   assert.equal(resolved.repo, selectedRepo);
   assert.deepEqual(calls, ["--version", "map search trace repository tooling --json", `map show ${selectedRepo} --json`]);
});
