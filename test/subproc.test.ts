import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import {
   getToolCallPolicyViolation,
   runReplicantSubprocess,
   type ReplicantSessionFactory,
   type ReplicantSessionLike,
   type ReplicantSessionFactoryInput,
} from "../extensions/replicant/subproc";

class FakeSession implements ReplicantSessionLike {
   state = { messages: [] as any[] };
   private listeners = new Set<(event: any) => void>();

   constructor(
      private readonly runPrompt: (session: FakeSession, text: string) => Promise<void>,
      private readonly onAbort?: () => void,
   ) { }

   subscribe(listener: (event: any) => void): () => void {
      this.listeners.add(listener);
      return () => {
         this.listeners.delete(listener);
      };
   }

   emit(event: any) {
      for (const listener of this.listeners) listener(event);
   }

   async prompt(text: string): Promise<void> {
      await this.runPrompt(this, text);
   }

   async abort(): Promise<void> {
      this.onAbort?.();
   }

   dispose(): void { }
}

function makeFactory(
   runPrompt: (session: FakeSession, text: string) => Promise<void>,
   onAbort?: () => void,
   setup?: (input: ReplicantSessionFactoryInput) => void,
): ReplicantSessionFactory {
   return async (input) => {
      setup?.(input);
      return new FakeSession(runPrompt, onAbort);
   };
}

test("runReplicantSubprocess truncates final assistant output to 2000 lines", async () => {
   const text = Array.from({ length: 2505 }, (_, i) => `line-${i + 1}`).join("\n");

   const result = await runReplicantSubprocess({
      cwd: process.cwd(),
      systemPrompt: "sys",
      taskPrompt: "task",
      tools: ["read"],
      sessionFactory: makeFactory(async (session) => {
         session.emit({ type: "tool_execution_start", toolName: "read", args: { path: "README.md" } });
         session.emit({ type: "tool_execution_end", toolName: "read", isError: false });
         const message = {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "end_turn",
         };
         session.state.messages.push(message);
         session.emit({ type: "message_end", message });
      }),
   });

   assert.equal(result.details.phase, "done");
   assert.equal(result.details.toolCalls, 1);
   assert.equal(result.details.toolErrors, 0);
   assert.equal(result.details.stopReason, "end_turn");
   assert.equal(result.details.truncation?.finalTextTruncated, true);
   assert.match(result.finalText, /line-2000/);
   assert.doesNotMatch(result.finalText, /line-2001/);
   assert.match(result.finalText, /\[replicant output truncated\]/);
});

test("runReplicantSubprocess treats stopReason=error as a failure", async () => {
   await assert.rejects(
      () =>
         runReplicantSubprocess({
            cwd: process.cwd(),
            systemPrompt: "sys",
            taskPrompt: "task",
            tools: ["read"],
            sessionFactory: makeFactory(async (session) => {
               const message = {
                  role: "assistant",
                  content: [{ type: "text", text: "" }],
                  stopReason: "error",
                  errorMessage: "upstream failed",
               };
               session.state.messages.push(message);
               session.emit({ type: "message_end", message });
            }),
         }),
      /stopReason=error: upstream failed/,
   );
});

test("runReplicantSubprocess reports aborted when signal is canceled", async () => {
   let aborted = false;
   const controller = new AbortController();
   controller.abort();

   await assert.rejects(
      () =>
         runReplicantSubprocess({
            cwd: process.cwd(),
            systemPrompt: "sys",
            taskPrompt: "task",
            tools: ["read"],
            signal: controller.signal,
            sessionFactory: makeFactory(async (session) => {
               const message = {
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                  stopReason: "end_turn",
               };
               session.state.messages.push(message);
               session.emit({ type: "message_end", message });
            }, () => {
               aborted = true;
            }),
         }),
      /Replicant subagent was aborted/,
   );

   assert.equal(aborted, true);
});


test("runReplicantSubprocess succeeds when final answer exists after turn-budget tool block", async () => {
   const budgetMessage = "Replicant subagent turn budget exceeded (6/6) before producing a final answer.";

   const result = await runReplicantSubprocess({
      cwd: process.cwd(),
      systemPrompt: "sys",
      taskPrompt: "task",
      tools: ["read"],
      sessionFactory: makeFactory(
         async (session) => {
            const message = {
               role: "assistant",
               content: [{ type: "text", text: "final answer" }],
               stopReason: "end_turn",
            };
            session.state.messages.push(message);
            session.emit({ type: "message_end", message });
         },
         undefined,
         (input) => {
            input.policyState.turnBudgetBlocked = budgetMessage;
         },
      ),
   });

   assert.equal(result.details.phase, "done");
   assert.equal(result.finalText, "final answer");
});

test("runReplicantSubprocess errors when turn-budget tool block yields no final answer", async () => {
   const budgetMessage = "Replicant subagent turn budget exceeded (6/6) before producing a final answer.";

   await assert.rejects(
      () =>
         runReplicantSubprocess({
            cwd: process.cwd(),
            systemPrompt: "sys",
            taskPrompt: "task",
            tools: ["read"],
            sessionFactory: makeFactory(
               async () => {
                  // no assistant output
               },
               undefined,
               (input) => {
                  input.policyState.turnBudgetBlocked = budgetMessage;
               },
            ),
         }),
      /turn budget exceeded \(6\/6\)/,
   );
});

test("getToolCallPolicyViolation rejects out-of-scope read path", () => {
   const cwd = process.cwd();
   const violation = getToolCallPolicyViolation({
      toolName: "read",
      input: { path: "/etc/passwd" },
      turnIndex: 0,
      toolCalls: 0,
      maxTurns: 6,
      maxToolCalls: 24,
      scope: {
         cwd,
         allowedRoots: [cwd],
         allowedFiles: [],
      },
   } as any);

   assert.match(String(violation), /out-of-scope read path: \/etc\/passwd/);
});

test("getToolCallPolicyViolation rejects unsafe find glob traversal", () => {
   const cwd = process.cwd();
   const violation = getToolCallPolicyViolation({
      toolName: "find",
      input: { path: ".", pattern: "../**/*.ts" },
      turnIndex: 0,
      toolCalls: 0,
      maxTurns: 6,
      maxToolCalls: 24,
      scope: {
         cwd,
         allowedRoots: [cwd],
         allowedFiles: [],
      },
   } as any);

   assert.match(String(violation), /out-of-scope find pattern: \.\.\/\*\*\/\*\.ts/);
});

test("getToolCallPolicyViolation enforces tool call budget", () => {
   const cwd = process.cwd();
   const violation = getToolCallPolicyViolation({
      toolName: "read",
      input: { path: "README.md" },
      turnIndex: 0,
      toolCalls: 24,
      maxTurns: 6,
      maxToolCalls: 24,
      scope: {
         cwd,
         allowedRoots: [cwd],
         allowedFiles: [],
      },
   } as any);

   assert.match(String(violation), /tool call budget exceeded \(24\/24\)/);
});

test("getToolCallPolicyViolation enforces turn budget", () => {
   const cwd = process.cwd();
   const violation = getToolCallPolicyViolation({
      toolName: "read",
      input: { path: "README.md" },
      turnIndex: 5,
      toolCalls: 0,
      maxTurns: 6,
      maxToolCalls: 24,
      scope: {
         cwd,
         allowedRoots: [cwd],
         allowedFiles: [],
      },
   } as any);

   assert.match(String(violation), /turn budget exceeded \(6\/6\)/);
});

test("getToolCallPolicyViolation allows in-scope read", () => {
   const cwd = process.cwd();
   const violation = getToolCallPolicyViolation({
      toolName: "read",
      input: { path: path.join(cwd, "README.md") },
      turnIndex: 0,
      toolCalls: 0,
      maxTurns: 6,
      maxToolCalls: 24,
      scope: {
         cwd,
         allowedRoots: [cwd],
         allowedFiles: [],
      },
   } as any);

   assert.equal(violation, undefined);
});
