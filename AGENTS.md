<!-- FORK SECTION — renekris/opencode-lowmem (branch lowmem, from port/ram-fixes). Everything between FORK BEGIN/END
     is fork-local; the rest of this file is upstream's guide. Resolve rebase conflicts
     in this file by keeping both sections. -->
<!-- FORK BEGIN -->

# Fork upkeep (renekris/opencode-lowmem)

Published at `renekris/opencode-lowmem` (default branch `lowmem`, releases cut per
`v*-lowmem.*` tag). The branch and tags are public history: never rewrite or delete
published tags, and never force-push the public branch except when Ren explicitly
directs a history consolidation; such a rewrite must first prove tree identity with
the pre-rewrite state. New work = new commits + a new lowmem round.

This checkout is a **resource-bounded fork** of anomalyco/opencode: full capability,
bounded footprint. Charter: every patch must bound a resource without removing a
capability. The README is the authoritative fork document (ported fixes, customs,
not-ported list, credit — keep its tables updated on every port).

## Hard rules

- Branches: `local-diff-caps` = pre-port customs baseline; `port/ram-fixes` = active
  fork line. Never force-push either; never rewrite or delete published tags.
- Never run `oc upgrade` before checking what it does to this tree — it rebuilds/resets
  the dist this fork occupies. The live binary is
  `packages/opencode/dist/opencode-linux-x64/bin/opencode`, path-exec'd by
  `~/.opencode/bin/opencode`; running sessions keep their old inode.
- Never kill running opencode sessions to "apply" a build. New sessions pick up new
  builds automatically.
- The db (`opencode.db`) is shared by old and new binaries. Only zero-migration changes
  may ship without a sandbox data-copy proof. Anything schema-touching needs its own
  gated round (sandbox data-copy proof required).
- **Never use the live data root for proofs.** The live `opencode.db` is tens of GiB
  and shared with running sessions. Never copy it, `sqlite3 .backup` it, or point any
  binary at it. Upkeep proofs run against synthetic XDG sandboxes (step 8). Only the
  gated summary-diff proof script may read the live root, and only for
  schema-touching rounds — if the db has outgrown that script's implicit size
  budget, stop and agree a strategy with Ren before running it.

## Agentic upkeep procedure (per upstream release)

1. `git fetch upstream --tags`; note the new tag.
2. Overlap check: `git diff --name-only <old-base>..<new-tag>` ∩ fork seam files
   (the README seam inventory). Zero overlap ⇒ clean merge expected.
3. **Merge** the tag into `port/ram-fixes` (`git merge vX.Y.Z`) — published history
   is never rebased. Version-bump conflicts in `package.json`/`bun.lock` are trivial:
   take theirs, then restore the fork's two carried lines — the
   `packages/sdk/js/package.json` typecheck script
   (`tsgo --noEmit && tsgo --noEmit -p test/tsconfig.json`) plus its
   `"@types/bun": "catalog:"` devDep, and the matching `"@types/bun": "catalog:"`
   line in `bun.lock`.
4. Schema gate: if the tag's diff adds db migrations (`data_migration`/drizzle/schema
   files), STOP — gated round with a sandbox data-copy proof before shipping.
5. Sweep upstream for unmerged memory/perf PRs:
   `gh api "search/issues?q=repo:anomalyco/opencode+is:pr+is:open+memory+OR+leak+OR+RSS"`.
   Port fixes-only candidates as `type(scope): summary (port of upstream #N)` and add
   a README table row crediting the author. Never drop the credit trailer.
6. Test the seams: run the guard suites named in the README seam inventory
   (`bun test <file>` from `packages/opencode` / `packages/core`) plus the touched
   customs' suites, and `bun run typecheck` in `packages/sdk/js`.
7. Update the README tables/watch-list, then build with `./scripts/fork-build.sh`
   (stamps `<base>-lowmem.<round>` from tags, smoke-tests, tags the build). The
   baked-in channel (`OPENCODE_CHANNEL=latest`) is MANDATORY — a wrong channel
   silently opens `opencode-<channel>.db`. If the shim was installed out-of-band
   (ELF binary carrying an older version), rerun with
   `OPENCODE_FORK_BUILD_ALLOW_SHIM_MISMATCH=1` — never "fix" the shim by hand.
8. Zero-migration proof — synthetic sandbox only, never the live db:
   `mkdir -p /tmp/synth/proj && cd /tmp/synth/proj`, then run the previous round's
   binary (`XDG_DATA_HOME=/tmp/synth/data ~/.opencode/bin/opencode session list`,
   exit 0 — creates a KB-scale db), then the new build
   (`XDG_DATA_HOME=/tmp/synth/data packages/opencode/dist/opencode-linux-x64/bin/opencode session list`,
   exit 0) and check `--version` reports the new stamp. Wipe `/tmp/synth` between rounds.
9. Update this file only if the procedure changed.

Summary-diff maintenance (schema-touching rounds): the durable seams are the
new-summary write in `packages/opencode/src/session/summary.ts` and the
legacy-clone trim in `Session.fork()` (`packages/opencode/src/session/session.ts`),
both calling the fork-owned `packages/opencode/src/session/summary-diff-trim.ts`.
The helper is write-only: new durable summaries keep metadata, retained snapshots
recompute patches on demand, pruned snapshots use metadata fallback; historical
events are untouched and no migration is needed. Re-run
`scripts/ram-bounds/summary-diff-proof.ts` after touching those seams, after
changing snapshot/session persistence, and before promoting a build. It generates
its own isolated sandbox and must never receive the live data root.

Rollback: revert the functional commits of the affected round(s) on the active line,
rebuild with `./scripts/fork-build.sh`, and verify the shim reports the new version
(`~/.opencode/bin/opencode --version`).

<!-- FORK END -->

- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.
