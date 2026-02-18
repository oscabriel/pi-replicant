import { Type, type Static } from "@sinclair/typebox";

export const MAX_TASK_LENGTH = 4000;
export const MAX_REPO_LENGTH = 200;
export const MAX_CWD_LENGTH = 1000;


export const ReplicantParamsSchema = Type.Object({
   task: Type.String({
      minLength: 1,
      maxLength: MAX_TASK_LENGTH,
      description: "What to investigate in the target codebase.",
   }),
   repo: Type.Optional(
      Type.String({
         minLength: 1,
         maxLength: MAX_REPO_LENGTH,
         description: "Preferred repo hint (owner/repo).",
      }),
   ),
   cwd: Type.Optional(
      Type.String({
         minLength: 1,
         maxLength: MAX_CWD_LENGTH,
         description: "Working directory override for Offworld commands.",
      }),
   ),
});

export type ReplicantParams = Static<typeof ReplicantParamsSchema>;

export function assertNoControlChars(value: string, fieldName: string) {
   if (/[^\P{Cc}\n\t]/u.test(value)) {
      throw new Error(`Invalid ${fieldName}: control characters are not allowed.`);
   }
}

export function normalizeRepoHint(repo?: string): string | undefined {
   if (!repo) return undefined;
   const trimmed = repo.trim();
   if (!trimmed) return undefined;
   return trimmed
      .replace(/^https?:\/\/github.com\//, "")
      .replace(/^github.com[:/]/, "")
      .replace(/\.git$/, "")
      .trim();
}
