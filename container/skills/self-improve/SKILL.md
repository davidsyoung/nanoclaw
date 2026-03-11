# Self-Improvement

You can modify your own source code via the git worktree at `/workspace/nanoclaw`.

## Workflow

1. **Read** the code in `/workspace/nanoclaw` to understand the current implementation
2. **Create a branch** from the current state:
   ```bash
   cd /workspace/nanoclaw
   git checkout -b agent/<short-description>
   ```
3. **Make changes** — edit files, add features, fix bugs
4. **Test** your changes (run `npm run build` to check for compile errors)
5. **Commit** your changes:
   ```bash
   cd /workspace/nanoclaw
   git add <files>
   git commit -m "description of changes"
   ```
6. **Request the update** using the `request_self_update` MCP tool with the branch name

## Rules

- Only fast-forward merges are accepted. Always branch from the current main HEAD.
- If the build fails after merge, the host automatically rolls back.
- After a successful update, the service restarts and your session ends.
- Keep changes small and focused. One logical change per update.
- The host code is read-only at `/workspace/project` for reference. The worktree at `/workspace/nanoclaw` is your writable copy.

## What You Can Change

- `src/` — Host orchestrator (message routing, IPC, container runner)
- `container/` — Agent runner, skills, Dockerfile
- `groups/` — Group configuration and memory
- Configuration files (package.json, tsconfig.json, etc.)

## Safety

- The host validates all merges (fast-forward only, must build cleanly)
- Failed builds trigger automatic rollback
- Only the main group can request self-updates
