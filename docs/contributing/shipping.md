# Starting, parallelizing, and shipping a task — full procedure

Full procedure moved from `AGENTS.md` §9. `AGENTS.md` §9 keeps the generic sequence. Machine-specific paths, personal identities, and transient checkout names from the original text have been replaced with placeholders.

## 9. Starting, parallelizing, and shipping a task

Every new goal follows this sequence. It applies to interactive sessions and
to the standing routines in `ops/routines/` (`docs/contributing/agent-routines.md`).

### Worktree

Fetch `origin/main`, then:

```bash
git worktree add -b <branch> <worktree-dir> origin/main
```

`git worktree` shares this clone's object database. Do not `git clone` a
second full copy of the repository, and do not nest the worktree inside
the primary checkout or commit it as files of that checkout. Leave
a checkout with `MERGE_HEAD` set alone: do not commit, abort, or finish that
merge to make room for the task. One task, one branch stack. Leave unrelated
dirty worktrees untouched.

### Shared caches

The disk stays near full. A new worktree gets source only.

- npm: install with the existing store (`npm config get cache`, the user store
  under `~/.local/share/npm/store`). `npm install` hardlinks from that
  store. Do not copy `node_modules` from another checkout.
- Cargo: `CARGO_TARGET_DIR=$HOME/.cache/packages/cargo-target` on every
  `cargo` invocation, in every worktree. Do not create a
  per-worktree `target/`.
- Playwright browsers stay in the existing browser cache. Do not download a
  second browser pack for a worktree.
- Skip `npm install` and Rust builds unless the task's checks need them.

### Swarm

Independent slices run together as a workflow (the standing entry point is
the `task-swarm.rhai` Grok workflow (OpenSesame Labs dotfiles), or a task-specific script when the slices
are fixed). Each slice is one agent
with a self-contained prompt and a disjoint set of files. Agents write only
inside the task worktree. The parent integrates, reviews, and is the only
one who opens pull requests.

### Incremental commits and stacked pull requests

One logical slice per commit. A multi-slice task is a stack: the first pull
request targets `main`, and each next pull request targets the previous
branch.

Only the bottom of a stack runs CI. Open every pull request above it as a
draft: a draft runs no suite, and the required checks fail on it by
design so a draft's head SHA can never read green. Mark a pull request ready
for review (`ready_for_review` starts CI) only once the one below has merged
and you have restacked it. Push at checkpoints, not per file: each push to an
open, non-draft pull request restarts CI.

Commit on the pull request's own branch. The commit that lands on `main` is
the squash GitHub creates and signs, so commits on a pull request branch do
not need a GitHub-verified signature of their own. The attribution check
(`scripts/lib/agent-commit-attribution.mjs`) accepts a commit on its author
identity or co-author trailer. An ordinary pushed commit merges.

Do not replay a branch onto a `-signed` twin or a staging branch to get
verified commits. Each replay leaves the branch it copied behind, and nothing
deletes it. The one case that still calls for a replay is a commit that claims
Grok and carries no Grok Build proof in its message. `land-signed-stack.mjs`
handles that case: it appends `Co-authored-by: Grok <noreply@x.ai>` because
`createCommitOnBranch` cannot set author, with `expectedHeadOid` at
`origin/main` for the first commit and the previous commit after that. It
writes to `<branch>-signed` and never deletes anything, so whoever runs it
deletes the source branch once the replayed tree is reported equal. The local
git identity, when a tool needs one, is your own configured identity and
signing key; it is never recorded in repository files.

### Branches

A task owns every branch it pushes, and none of them outlives the task.
Auto-delete removes exactly one kind of branch: the head of a pull request
that merges. Everything else stays until someone deletes it.

- One branch per pull request, and no second copy of it under another name.
- Restack in place. Rewrite the pull request's own branch
  (`--force-with-lease`, on a branch you created) and keep the same pull
  request. A new branch per attempt (`-v2`, `-restack`, a dated suffix) closes
  the old pull request and strands its branch.
- Verify on the pull request branch, through its own CI. Do not push `review/`,
  `work/` or other scratch branches to `origin` to run a check. Where a check
  truly needs a scratch branch, delete it as soon as its result is read.
- A tool that creates a signing, staging or replay ref deletes that ref before
  it exits, whether it succeeded or failed.
- Closing a pull request without merging deletes its branch. The commits stay
  reachable at `refs/pull/<n>/head`, so nothing is lost.
- A session that cannot delete a remote ref, such as a cloud session that
  pushes only to its own branch, pushes no branch except its pull request
  branch.

### After each commit

Run `df -h /`. Delete scratch under `/tmp` that this commit created, and any
build output that exists only because of that commit. Leave unrelated
worktrees, running local services, and the primary checkout's uncommitted
work in place. Remove a
task worktree only after its branch has been squash-merged and its remote
branch deleted (`git worktree remove`, then `git worktree prune`).

### Done

When every pull request in the stack is open:

1. Self-review the diff and post that review on each pull request. Resolve
   every review thread opened on the stack.
2. A Copilot review request on this repository returns HTTP 422. CodeRabbit
   does not auto-review while the repository has fewer than 10 stars. The
   self-review is the review that has to land.
3. Squash-merge only after every required check in
   `ops/github/default-branch.json` is green on the current head and the pull
   request is up to date with `main`. The ruleset is squash-only. This is a
   single-maintainer repository, so no second reviewer exists to approve: a
   green pull request merges through the owner's pull-request bypass, which
   the ruleset grants for that purpose. An agent uses that bypass only when
   the owner has told the session to merge, and never to pass a red or pending
   check. A finished pull request left open is how its branch gets stranded.
4. Merge from the bottom of the stack. After each squash, restack the next
   branch in place onto the new `main` and squash-merge it the same way.
5. Remove the finished worktree and delete the local branch and every remote
   branch the task pushed (see Branches). The merged head is deleted for you;
   check that nothing else is left.

User-visible product changes still follow §5 visual evidence and §8 gates.
This section is how the work is hosted. It does not waive those gates.

### Local task queue

`ops/routines/*.md` and `docs/contributing/agent-routines.md` are the local
task queue. Each routine starts with this same worktree, shared-cache, swarm,
stack, disk-check, and squash-merge sequence. A routine that edits the tree
does that work in its own `<worktree-dir>`, with independent findings fanned
out through the `task-swarm.rhai` Grok workflow (OpenSesame Labs dotfiles).
