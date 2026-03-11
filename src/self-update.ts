/**
 * Self-Update Module for NanoClaw
 *
 * Allows the container agent to propose code changes via a git worktree.
 * The agent commits to a branch in the worktree, then requests the host
 * to merge (fast-forward only), rebuild, and restart.
 */
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

import { logger } from './logger.js';

const PROJECT_ROOT = process.cwd();
const WORKTREE_PATH = path.join(
  process.env.HOME || '/tmp',
  'Dev',
  'nanoclaw-agent-work',
);

export interface SelfUpdateResult {
  success: boolean;
  message: string;
  branch?: string;
  commitSha?: string;
}

/**
 * Apply a self-update from the agent's worktree branch.
 *
 * Flow:
 * 1. Fetch the worktree's branch into the main repo
 * 2. Verify the branch is a fast-forward of main
 * 3. Merge with --ff-only
 * 4. Run npm run build
 * 5. Restart the service via launchctl (macOS) or systemd (Linux)
 * 6. On failure: rollback to previous HEAD
 */
export async function applySelfUpdate(
  branch: string,
  sourceGroup: string,
): Promise<SelfUpdateResult> {
  const prevHead = run('git rev-parse HEAD').trim();

  try {
    // 1. Validate worktree exists
    if (!fs.existsSync(WORKTREE_PATH)) {
      return {
        success: false,
        message: `Worktree not found at ${WORKTREE_PATH}`,
      };
    }

    // 2. Fetch the branch from the worktree (it's a linked worktree, shares .git)
    //    The agent commits in the worktree on a branch. We just merge that branch.
    const branchExists = run(`git branch --list ${branch}`).trim();
    if (!branchExists) {
      return {
        success: false,
        message: `Branch "${branch}" not found. Did the agent commit and push?`,
      };
    }

    // 3. Verify it's a fast-forward (the branch must be ahead of current HEAD)
    const mergeBase = run(`git merge-base HEAD ${branch}`).trim();
    if (mergeBase !== prevHead) {
      return {
        success: false,
        message: `Branch "${branch}" has diverged from main. Only fast-forward merges are allowed.`,
      };
    }

    // 4. Merge fast-forward only
    run(`git merge --ff-only ${branch}`);
    const newHead = run('git rev-parse HEAD').trim();

    logger.info(
      { branch, prevHead, newHead, sourceGroup },
      'Self-update merged',
    );

    // 5. Rebuild
    try {
      run('npm run build', 60_000);
    } catch (buildErr) {
      // Rollback on build failure
      logger.error({ buildErr }, 'Build failed after merge, rolling back');
      run(`git reset --hard ${prevHead}`);
      run('npm run build', 60_000);
      return {
        success: false,
        message: `Build failed after merge. Rolled back to ${prevHead.slice(0, 8)}.`,
        branch,
        commitSha: newHead,
      };
    }

    // 6. Restart the service
    try {
      restart();
    } catch (restartErr) {
      logger.warn({ restartErr }, 'Restart command failed (service may still restart)');
    }

    return {
      success: true,
      message: `Updated to ${newHead.slice(0, 8)}. Restarting...`,
      branch,
      commitSha: newHead,
    };
  } catch (err) {
    // General rollback
    try {
      run(`git reset --hard ${prevHead}`);
    } catch {
      // ignore rollback failure
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, sourceGroup }, 'Self-update failed');
    return {
      success: false,
      message: `Self-update failed: ${msg}. Rolled back.`,
    };
  }
}

function run(cmd: string, timeout = 30_000): string {
  return execSync(cmd, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function restart(): void {
  const uid = process.getuid?.();
  if (process.platform === 'darwin') {
    // launchd restart — kickstart kills and restarts the service
    const label = 'com.nanoclaw';
    execSync(`launchctl kickstart -k gui/${uid}/${label}`, {
      timeout: 10_000,
    });
  } else {
    // systemd restart
    execSync('systemctl --user restart nanoclaw', { timeout: 10_000 });
  }
}
