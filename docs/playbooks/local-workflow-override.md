# Local Workflow Override Playbook

How to run Symphony with personal workflow changes without editing the
project's committed `WORKFLOW.md`. Written for both human operators and
coding agents: every step is explicit and copy-pasteable.

## When to use this

- You want to opt into a runtime or provisioner setting the rest of the team
  has not adopted yet (for example `workspace.provisioner.type: clone` for the
  opt-in Claude CLI runtime, which rejects linked worktrees).
- You need host-specific hook additions (for example materializing `.venv`
  interpreter symlinks so the sandbox sensitive-file audit passes).
- You are experimenting with workflow settings and do not want a dirty
  repository, which `allow_dirty_repo: false` would turn into a dispatch
  blocker.

Do not use this to fork team behavior permanently. The override is a staging
area; settings that prove out belong in the committed `WORKFLOW.md` via a
normal PR. Delete the override once its contents land upstream.

## How it works

Symphony resolves the workflow file in this precedence order:

1. Positional workflow path, when the command supports one
2. Explicit `--workflow <path>` flag
3. Ambient `SYMPHONY_WORKFLOW_PATH` process environment variable
4. Default: `WORKFLOW.md` in the current directory

The project root, the effective `.env` file, relative workspace paths, and
project-local portable skill paths are all derived from the directory
containing the resolved workflow file. This yields two hard rules:

- **The override file must live in the project root**, next to the canonical
  `WORKFLOW.md`. A copy elsewhere (for example under `~/.config`) silently
  relocates the project root and breaks `.env`, skill, and workspace
  resolution.
- **Relative paths inside the override keep working unchanged** precisely
  because the file stays in the project root.

## Setup

All commands run from the project root.

1. Copy the canonical workflow and apply your changes to the copy:

   ```bash
   cp WORKFLOW.md WORKFLOW.local.md
   # edit WORKFLOW.local.md
   ```

2. Hide it from git without touching the repository. Use your user-level
   global ignore file, not the project `.gitignore` (editing tracked files
   would recreate the dirty-repo problem you are avoiding):

   ```bash
   mkdir -p ~/.config/git
   echo "WORKFLOW.local.md" >> ~/.config/git/ignore
   git check-ignore WORKFLOW.local.md && echo ok
   ```

3. Point each Symphony command at the override explicitly:

   ```bash
   symphony setup --workflow ./WORKFLOW.local.md --yes
   symphony doctor --workflow ./WORKFLOW.local.md
   symphony dashboard --workflow ./WORKFLOW.local.md
   ```

   Keep the same flag in aliases or start scripts. Alternatively, export an
   ambient variable before running any of the commands:

   ```bash
   export SYMPHONY_WORKFLOW_PATH="$PWD/WORKFLOW.local.md"
   ```

   Do not put `SYMPHONY_WORKFLOW_PATH` in the project `.env`. Symphony must
   resolve the workflow before it knows which project `.env` to load, so that
   file cannot select its own workflow.

## Caveats

- **Drift.** Your copy does not receive team updates to `WORKFLOW.md`.
  Review the difference regularly and rebase your override onto the current
  canonical file:

  ```bash
  diff WORKFLOW.md WORKFLOW.local.md
  ```

- **Consent re-binding.** High-trust setup consent binds to the workflow
  content. Every edit to `WORKFLOW.local.md` invalidates recorded consent;
  re-run `symphony setup --workflow ./WORKFLOW.local.md --yes` after each
  edit.

- **Wrong-file confusion.** Running doctor without the workflow flag or ambient variable,
  or starting the dashboard with `--workflow ./WORKFLOW.md`, validates the
  canonical file and reports its blockers, not yours. If doctor output
  suddenly disagrees with your configuration, check the `workflow:` line in
  its resolved context first.

## Teardown

When the team commits your settings to the canonical `WORKFLOW.md` (or you
abandon the experiment):

```bash
rm WORKFLOW.local.md
```

Then unset `SYMPHONY_WORKFLOW_PATH`, remove any shell alias and the global
ignore entry. The canonical workflow takes over with no residue.
