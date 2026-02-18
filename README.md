# pi-replicant

Codebase exploration subagent extension for [pi](https://github.com/badlogic/pi-mono) coding agent using [Offworld](https://github.com/oscabriel/offworld) CLI.

`replicant` keeps main-session context lean by delegating external repo exploration to an isolated in-process subagent session that can “go offworld” to explore distant code (i.e. use the Offworld CLI to resolve and access repositories outside your current working tree).

## What it does

- Registers a single tool: `replicant`.
- Uses tool description + parameter schema + internal subagent prompting.
- Resolves repo clone/reference paths via Offworld CLI (`ow map show`, `ow map search`).
- Optionally bootstraps missing repo clones with `ow pull <owner/repo> --clone-only` (for fast results).
- Runs an isolated in-process subagent session with resource loading locked down (`noExtensions`, `noSkills`, `noPromptTemplates`, `noThemes`).
- Runs a single robust reconnaissance profile with read-only tools (`read,grep,find,ls`) and fixed exploration budgets.
- Enforces defensive execution policy (scope checks, unsafe glob rejection, turn/tool-call budgets).
- Streams progress updates and returns concise evidence-oriented findings about target repo.

## Tool interface

```ts
replicant({
  task: string,
  repo?: string,
  cwd?: string,
})
```

## Installation

From npm:

```bash
pi install npm:pi-replicant
```

From local path (development):

```bash
pi install /absolute/path/to/pi-replicant
```

Run once without install:

```bash
pi -e npm:pi-replicant
```

## Requirements

- `pi` coding agent
- `offworld` cli
- for best results, pull your target repos with `ow pull <owner/repo> --clone-only` before using the replicant subagent

## Development checks

```bash
bun run typecheck
bun run pack:check
```

## Repository layout

```text
pi-replicant/
  extensions/replicant/
    index.ts
    offworld.ts
    schemas.ts
    subproc.ts
```
