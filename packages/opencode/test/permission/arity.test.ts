import { test, expect } from "bun:test"
import { BashArity } from "../../src/permission/arity"

test("arity 1 - unknown commands default to first token", () => {
  expect(BashArity.prefix(["unknown", "command", "subcommand"])).toEqual(["unknown"])
  expect(BashArity.prefix(["touch", "foo.txt"])).toEqual(["touch"])
})

test("arity 2 - two token commands", () => {
  expect(BashArity.prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"])
})

test("arity 3 - three token commands", () => {
  expect(BashArity.prefix(["aws", "s3", "ls", "my-bucket"])).toEqual(["aws", "s3", "ls"])
  expect(BashArity.prefix(["npm", "run", "dev", "script"])).toEqual(["npm", "run", "dev"])
})

test("longest match wins - nested prefixes", () => {
  expect(BashArity.prefix(["docker", "compose", "up", "service"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["consul", "kv", "get", "config"])).toEqual(["consul", "kv", "get"])
})

test("exact length matches", () => {
  expect(BashArity.prefix(["git", "checkout"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
})

test("edge cases", () => {
  expect(BashArity.prefix([])).toEqual([])
  expect(BashArity.prefix(["single"])).toEqual(["single"])
  expect(BashArity.prefix(["git"])).toEqual(["git"])
})

test("git permission patterns ignore arguments after the subcommand", () => {
  expect(BashArity.permissionPattern(["git", "commit", "-m", "secure cleanup"], "git commit -m 'secure cleanup'")).toBe(
    "git commit *",
  )
  expect(
    BashArity.permissionPattern(["git", "push", "--dry-run", "origin", "commit"], "git push --dry-run origin commit"),
  ).toBe("git push *")
  expect(BashArity.permissionPattern(["git", "clean", "-n", "commit"], "git clean -n commit")).toBe("git clean *")
  expect(BashArity.permissionPattern(["git", "add", "path/secure-cleanup.kt"], "git add path/secure-cleanup.kt")).toBe(
    "git add *",
  )
  expect(BashArity.permissionPattern(["git", "branch", "--show-current"], "git branch --show-current")).toBe(
    "git branch --show-current *",
  )
  expect(BashArity.permissionPattern(["git", "worktree", "list"], "git worktree list")).toBe("git worktree list *")
})

test("git permission patterns unwrap environment prefixes and global options", () => {
  expect(
    BashArity.permissionPattern(
      ["GIT_MASTER=1", "git", "commit", "-m", "document git clean behavior"],
      "GIT_MASTER=1 git commit -m 'document git clean behavior'",
    ),
  ).toBe("git commit *")
  expect(BashArity.permissionPattern(["env", "GIT_MASTER=1", "git", "status"], "env GIT_MASTER=1 git status")).toBe(
    "git status *",
  )
  expect(
    BashArity.permissionPattern(["git", "-C", "repo", "remote", "add", "origin"], "git -C repo remote add origin"),
  ).toBe("git remote add *")
  expect(BashArity.alwaysPattern(["GIT_MASTER=1", "git", "commit", "-m", "message"])).toBe("git commit *")
  expect(BashArity.alwaysPattern(["git", "-C", "repo", "remote", "add", "origin"])).toBe("git remote add *")
})

test("non-git permission patterns preserve the full command", () => {
  const command = "printf 'git clean'"
  expect(BashArity.permissionPattern(["printf", "git clean"], command)).toBe(command)
})

test("always patterns are suppressed for privilege wrapper prefixes", () => {
  expect(BashArity.alwaysPattern(["sudo", "git", "status"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["sudo", "rm", "-rf", "/tmp/cache"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["doas", "git", "status"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["nohup", "npm", "run", "dev"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["nice", "-n", "10", "make"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["time", "git", "status"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["exec", "make", "all"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["timeout", "30", "git", "status"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["stdbuf", "-oL", "make"])).toBeUndefined()
  // A wrapper hidden behind an unwrapped env prefix is still detected.
  expect(BashArity.alwaysPattern(["env", "GIT_MASTER=1", "sudo", "git", "status"])).toBeUndefined()
  // Path-qualified wrappers and unwrappers are matched by basename.
  expect(BashArity.alwaysPattern(["/usr/bin/sudo", "git", "status"])).toBeUndefined()
  expect(BashArity.alwaysPattern(["/usr/bin/env", "GIT_MASTER=1", "git", "status"])).toBeUndefined()
  // Unwrapped commands keep their scoped always patterns.
  expect(BashArity.alwaysPattern(["env", "GIT_MASTER=1", "git", "status"])).toBe("git status *")
  expect(BashArity.alwaysPattern(["npm", "run", "dev", "watch"])).toBe("npm run dev *")
})
