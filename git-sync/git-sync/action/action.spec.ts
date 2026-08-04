import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAction } from './action.js';

type Call = { cmd: string; args: string[] };
type Op = { kind: 'chdir'; dir: string } | { kind: 'exec'; cmd: string; args: string[] };

function fakeExec(calls: Call[], exitCode = 0) {
  return async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return exitCode;
  };
}

/** Records chdir/exec calls into a single ordered log, to assert relative ordering. */
function fakeOps(ops: Op[], exitCode = 0) {
  return {
    chdir: (dir: string) => {
      ops.push({ kind: 'chdir', dir });
    },
    exec: async (cmd: string, args: string[]) => {
      ops.push({ kind: 'exec', cmd, args });
      return exitCode;
    },
  };
}

describe('runAction', () => {
  it('routes a repository_dispatch event to `bit ci sync <full scope-qualified laneId> --log info` and returns the exec exit code', async () => {
    const calls: Call[] = [];
    const env = { GITHUB_EVENT_NAME: 'repository_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json' };
    const event = {
      action: 'bit-export',
      client_payload: { laneId: 'org.scope/feature-x' },
      repository: { default_branch: 'main' },
    };

    const exitCode = await runAction({
      env,
      readEventFile: () => event,
      // the availability probe succeeds; the real command exits 7, and that is the code the action returns
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return args.includes('--help') ? 0 : 7;
      },
    });

    expect(exitCode).toBe(7);
    expect(calls).toEqual([
      { cmd: 'git', args: ['config', 'user.name', 'bit-sync[bot]'] },
      { cmd: 'git', args: ['config', 'user.email', 'bit-sync[bot]@users.noreply.github.com'] },
      { cmd: 'bit', args: ['ci', 'sync', '--help'] },
      { cmd: 'bit', args: ['ci', 'sync', 'org.scope/feature-x', '--log', 'info'] },
    ]);
  });

  it('returns 0 without calling exec when the route is a skip', async () => {
    const calls: Call[] = [];
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/tmp/event.json' };
    const event = {
      ref: 'refs/heads/main',
      head_commit: { message: 'wip' },
      repository: { default_branch: 'main' },
    };

    const exitCode = await runAction({
      env,
      readEventFile: () => event,
      exec: fakeExec(calls),
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
  });

  it('configures git identity from GIT_USER_NAME/GIT_USER_EMAIL when provided', async () => {
    const calls: Call[] = [];
    const env = {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: '/tmp/event.json',
      GIT_USER_NAME: 'custom-bot',
      GIT_USER_EMAIL: 'custom-bot@example.com',
    };
    const event = { inputs: { lane: 'feature-x' }, repository: { default_branch: 'main' } };

    await runAction({ env, readEventFile: () => event, exec: fakeExec(calls) });

    expect(calls[0]).toEqual({ cmd: 'git', args: ['config', 'user.name', 'custom-bot'] });
    expect(calls[1]).toEqual({ cmd: 'git', args: ['config', 'user.email', 'custom-bot@example.com'] });
    expect(calls[calls.length - 1]).toEqual({ cmd: 'bit', args: ['ci', 'sync', 'feature-x', '--log', 'info'] });
  });

  it('reads the event payload from GITHUB_EVENT_PATH', async () => {
    const calls: Call[] = [];
    const seenPaths: string[] = [];
    const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: '/tmp/my-event.json' };

    await runAction({
      env,
      readEventFile: (path) => {
        seenPaths.push(path);
        return { repository: { default_branch: 'main' } };
      },
      exec: fakeExec(calls),
    });

    expect(seenPaths).toEqual(['/tmp/my-event.json']);
  });

  it('routes pull_request merges to `bit ci merge --log info`', async () => {
    const calls: Call[] = [];
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/tmp/event.json' };
    const event = {
      pull_request: { merged: true, head: { ref: 'feature-x' } },
      repository: { default_branch: 'main' },
    };

    const exitCode = await runAction({ env, readEventFile: () => event, exec: fakeExec(calls, 0) });

    expect(exitCode).toBe(0);
    expect(calls[calls.length - 1]).toEqual({ cmd: 'bit', args: ['ci', 'merge', '--log', 'info'] });
  });

  it('passes pull_request.base.ref through as baseRef, so a merge into a non-default base is skipped', async () => {
    const calls: Call[] = [];
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/tmp/event.json' };
    const event = {
      pull_request: { merged: true, head: { ref: 'feature-x-part-2' }, base: { ref: 'feature-x' } },
      repository: { default_branch: 'main' },
    };

    const exitCode = await runAction({ env, readEventFile: () => event, exec: fakeExec(calls) });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
  });

  it('runs `bit ci merge` when pull_request.base.ref IS the default branch', async () => {
    const calls: Call[] = [];
    const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/tmp/event.json' };
    const event = {
      pull_request: { merged: true, head: { ref: 'feature-x' }, base: { ref: 'main' } },
      repository: { default_branch: 'main' },
    };

    await runAction({ env, readEventFile: () => event, exec: fakeExec(calls) });

    expect(calls[calls.length - 1]).toEqual({ cmd: 'bit', args: ['ci', 'merge', '--log', 'info'] });
  });

  it('strips newlines out of payload-derived text before logging it (no ::workflow-command injection)', async () => {
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logged.push(msg);
    });

    try {
      const env = { GITHUB_EVENT_NAME: 'repository_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json' };
      const event = {
        action: 'bit-export',
        // A lane name carrying its own workflow command on a second line.
        client_payload: { laneId: 'scope/bad\n::add-mask::secret' },
        repository: { default_branch: 'main' },
      };

      const exitCode = await runAction({ env, readEventFile: () => event, exec: fakeExec([]) });

      expect(exitCode).toBe(0);
      expect(logged).toHaveLength(1);
      expect(logged[0]).not.toContain('\n');
      expect(logged[0]).not.toContain('\r');
      // The text is still there for a human to read -- it just cannot start a
      // new stdout line that Actions would parse as a command.
      expect(logged[0]).toContain('::add-mask::secret');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('uses the main-sync-branch action input (INPUT_MAIN-SYNC-BRANCH) to skip pushes to it', async () => {
    const calls: Call[] = [];
    const env = {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: '/tmp/event.json',
      'INPUT_MAIN-SYNC-BRANCH': 'custom-sync-branch',
    };
    const event = {
      ref: 'refs/heads/custom-sync-branch',
      head_commit: { message: 'wip' },
      repository: { default_branch: 'main' },
    };

    const exitCode = await runAction({ env, readEventFile: () => event, exec: fakeExec(calls) });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
  });

  it('falls back to `main` as the default branch when the event payload has no repository.default_branch', async () => {
    const calls: Call[] = [];
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/tmp/event.json' };
    const event = { ref: 'refs/heads/main', head_commit: { message: 'wip' } };

    const exitCode = await runAction({ env, readEventFile: () => event, exec: fakeExec(calls) });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([]);
  });

  it('chdirs into INPUT_WS-DIR before running any command, when set to a non-"." path', async () => {
    const ops: Op[] = [];
    const env = {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_EVENT_PATH: '/tmp/event.json',
      'INPUT_WS-DIR': 'sub/dir',
    };
    const event = { inputs: { lane: 'feature-x' }, repository: { default_branch: 'main' } };

    const { chdir, exec } = fakeOps(ops);
    await runAction({ env, readEventFile: () => event, exec, chdir });

    expect(ops[0]).toEqual({ kind: 'chdir', dir: 'sub/dir' });
    // chdir happens before any exec call (git identity config, then `bit ci`).
    expect(ops.slice(1).every((op) => op.kind === 'exec')).toBe(true);
    expect(ops.filter((op) => op.kind === 'chdir')).toHaveLength(1);
  });

  it('does not chdir when INPUT_WS-DIR is unset or "."', async () => {
    const opsUnset: Op[] = [];
    const opsDot: Op[] = [];
    const baseEvent = { inputs: { lane: 'feature-x' }, repository: { default_branch: 'main' } };

    await runAction({
      env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: () => baseEvent,
      ...fakeOps(opsUnset),
    });
    await runAction({
      env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json', 'INPUT_WS-DIR': '.' },
      readEventFile: () => baseEvent,
      ...fakeOps(opsDot),
    });

    expect(opsUnset.some((op) => op.kind === 'chdir')).toBe(false);
    expect(opsDot.some((op) => op.kind === 'chdir')).toBe(false);
  });

  it('rejects without calling exec("bit", ...) when readEventFile throws (unreadable path / invalid JSON)', async () => {
    const calls: Call[] = [];
    const env = { GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: '/tmp/does-not-exist.json' };

    await expect(
      runAction({
        env,
        readEventFile: () => {
          throw new Error('ENOENT: no such file or directory');
        },
        exec: fakeExec(calls),
      })
    ).rejects.toThrow('ENOENT');

    expect(calls.some((call) => call.cmd === 'bit')).toBe(false);
    expect(calls).toEqual([]);
  });

  describe('repoScope from workspace.jsonc (Stage 0 cross-scope-lane filter)', () => {
    // A realistic workspace.jsonc, JSONC comments and all -- this is the
    // shape `readTextFile` actually sees in production, and JSON.parse would
    // throw on it.
    const workspaceJsonc = `/**
 * this is the main configuration file of your bit workspace.
 **/{
  "$schema": "https://static.bit.dev/teambit/schemas/schema.json",
  "teambit.workspace/workspace": {
    // the name of the component workspace.
    "name": "cards-repo",
    "defaultScope": "acme.cards"
  }
}
`;

    it('reads defaultScope via readTextFile and applies it to the cross-scope relevance filter', async () => {
      const calls: Call[] = [];
      const seenPaths: string[] = [];
      const env = { GITHUB_EVENT_NAME: 'repository_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json' };
      const event = {
        action: 'bit-export',
        client_payload: { laneId: 'acme.cards/cross-scope', componentIds: 'acme.shop/bar@1.0.0' },
        repository: { default_branch: 'main' },
      };

      const exitCode = await runAction({
        env,
        readEventFile: () => event,
        readTextFile: (path) => {
          seenPaths.push(path);
          return workspaceJsonc;
        },
        exec: fakeExec(calls),
      });

      // componentIds only touch acme.shop, but workspace.jsonc's
      // defaultScope is acme.cards -- irrelevant, so it's skipped.
      expect(exitCode).toBe(0);
      expect(calls).toEqual([]);
      expect(seenPaths).toEqual(['workspace.jsonc']);
    });

    it('runs (does not skip) when a relevant scope is present in componentIds', async () => {
      const calls: Call[] = [];
      const env = { GITHUB_EVENT_NAME: 'repository_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json' };
      const event = {
        action: 'bit-export',
        client_payload: { laneId: 'acme.cards/cross-scope', componentIds: 'acme.cards/foo@1.0.0' },
        repository: { default_branch: 'main' },
      };

      await runAction({
        env,
        readEventFile: () => event,
        readTextFile: () => workspaceJsonc,
        exec: fakeExec(calls),
      });

      expect(calls[calls.length - 1]).toEqual({
        cmd: 'bit',
        args: ['ci', 'sync', 'acme.cards/cross-scope', '--log', 'info'],
      });
    });

    it('reads workspace.jsonc relative to the REAL post-chdir cwd exactly once (regression: previously double-joined ws-dir)', async () => {
      // Simulates the real process.chdir + fs.readFileSync interaction:
      // `chdir` mutates a tracked "cwd", and `readTextFile` resolves its
      // (relative) path argument against that same cwd -- exactly what
      // fs.readFileSync does with a relative path in production. A no-op
      // chdir stub (as an earlier version of this test used) can't catch a
      // double-join bug, because it never actually changes anything for a
      // bare-path read to be resolved against.
      let cwd = '/repo';
      const files: Record<string, string> = {
        '/repo/sub/dir/workspace.jsonc': workspaceJsonc,
      };
      const readCalls: string[] = [];

      const fakeChdir = (dir: string) => {
        cwd = join(cwd, dir);
      };
      const fakeReadTextFile = (path: string) => {
        const resolved = join(cwd, path);
        readCalls.push(resolved);
        const content = files[resolved];
        if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${resolved}'`);
        return content;
      };

      const calls: Call[] = [];
      const env = {
        GITHUB_EVENT_NAME: 'repository_dispatch',
        GITHUB_EVENT_PATH: '/tmp/event.json',
        'INPUT_WS-DIR': 'sub/dir',
      };
      const event = {
        action: 'bit-export',
        client_payload: { laneId: 'acme.cards/cross-scope', componentIds: 'acme.cards/foo@1.0.0' },
        repository: { default_branch: 'main' },
      };

      await runAction({
        env,
        readEventFile: () => event,
        readTextFile: fakeReadTextFile,
        chdir: fakeChdir,
        exec: fakeExec(calls),
      });

      // Read exactly once, and resolved to <original cwd>/<ws-dir>/workspace.jsonc
      // -- never doubled to .../sub/dir/sub/dir/workspace.jsonc.
      expect(readCalls).toEqual(['/repo/sub/dir/workspace.jsonc']);
      // The file was actually found and its defaultScope applied: componentIds
      // matches acme.cards, so the export runs rather than being (wrongly)
      // treated as scope-unknown.
      expect(calls[calls.length - 1]).toEqual({
        cmd: 'bit',
        args: ['ci', 'sync', 'acme.cards/cross-scope', '--log', 'info'],
      });
    });

    it('still runs when workspace.jsonc is missing (readTextFile throws): repoScope stays undefined, fail open', async () => {
      const calls: Call[] = [];
      const env = { GITHUB_EVENT_NAME: 'repository_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json' };
      const event = {
        action: 'bit-export',
        client_payload: { laneId: 'acme.cards/cross-scope', componentIds: 'acme.shop/bar@1.0.0' },
        repository: { default_branch: 'main' },
      };

      const exitCode = await runAction({
        env,
        readEventFile: () => event,
        readTextFile: () => {
          throw new Error('ENOENT: no such file or directory');
        },
        exec: fakeExec(calls, 0),
      });

      // No repoScope to filter by -> fails open -> routes and runs, rather
      // than throwing or skipping.
      expect(exitCode).toBe(0);
      expect(calls[calls.length - 1]).toEqual({
        cmd: 'bit',
        args: ['ci', 'sync', 'acme.cards/cross-scope', '--log', 'info'],
      });
    });

    it('still runs when readTextFile is not provided at all: repoScope stays undefined, fail open', async () => {
      const calls: Call[] = [];
      const env = { GITHUB_EVENT_NAME: 'repository_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json' };
      const event = {
        action: 'bit-export',
        client_payload: { laneId: 'acme.cards/cross-scope', componentIds: 'acme.shop/bar@1.0.0' },
        repository: { default_branch: 'main' },
      };

      const exitCode = await runAction({ env, readEventFile: () => event, exec: fakeExec(calls, 0) });

      expect(exitCode).toBe(0);
      expect(calls[calls.length - 1]).toEqual({
        cmd: 'bit',
        args: ['ci', 'sync', 'acme.cards/cross-scope', '--log', 'info'],
      });
    });
  });
});

/**
 * Walks up from this file looking for the repo root, identified by having BOTH
 * `action.yml` and `dist/index.js`. Returns undefined when not found — which is
 * the expected outcome inside an isolated capsule, where only the component's
 * own files are present.
 */
function findBundle(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  const { root } = parse(dir);

  while (true) {
    if (existsSync(join(dir, 'action.yml')) && existsSync(join(dir, 'dist', 'index.js'))) {
      return join(dir, 'dist', 'index.js');
    }
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

/** Runs `node <file>` with `env` merged over the ambient env; captures output. */
function runNode(file: string, env: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Guards the committed `dist/index.js` action bundle, which no other test
 * touches: `action.yml` declares it as `main` and GitHub Actions executes it
 * verbatim with no build step, so a bundle that crashes on load (e.g. one
 * emitted as CommonJS under the root `"type": "module"`) passes every unit
 * test above while being entirely broken in production.
 *
 * `npm run verify-bundle` is the authoritative gate — it additionally proves
 * the committed bundle is not stale. This spec is the in-suite tripwire.
 */
describe('dist/index.js (committed action bundle)', () => {
  const bundle = findBundle();

  it.skipIf(!bundle)('loads under the real Node loader and routes a no-op push to a skip, exiting 0', async () => {
    // A `push` event with no GITHUB_EVENT_PATH routes to a skip, so this
    // exercises module load plus the full production wiring without ever
    // spawning `git` or `bit`.
    const { code, output } = await runNode(bundle!, {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: '',
      'INPUT_WS-DIR': '.',
    });

    expect(output).toContain('[bit-git-sync] skipping');
    expect(code).toBe(0);
  }, 30_000);

  /**
   * `bit ci sync` is newer than `bit ci pr` / `bit ci merge`, so a released bit can route here and
   * fail with "unknown command". The probe turns that into a named requirement.
   */
  it('refuses to run a sync when this bit has no "bit ci sync", and never runs the real command', async () => {
    const calls: Call[] = [];
    const code = await runAction({
      env: { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: () => ({ inputs: { lane: 'feature-x' }, repository: { default_branch: 'main' } }),
      chdir: () => {},
      // the probe fails; every other command succeeds
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return args[1] === 'sync' && args[2] === '--help' ? 1 : 0;
      },
    });

    expect(code).toBe(1);
    expect(calls.filter((call) => call.cmd === 'bit')).toEqual([{ cmd: 'bit', args: ['ci', 'sync', '--help'] }]);
  });

  it('does not probe for a merge, which every released bit already has', async () => {
    const calls: Call[] = [];
    await runAction({
      env: { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: '/tmp/event.json' },
      readEventFile: () => ({
        action: 'closed',
        pull_request: { merged: true, head: { ref: 'feature-x' }, base: { ref: 'main' } },
        repository: { default_branch: 'main' },
      }),
      ...fakeOps([] as Op[]),
      exec: async (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return 0;
      },
    });

    expect(calls.some((call) => call.args.includes('--help'))).toBe(false);
    expect(calls[calls.length - 1]).toEqual({ cmd: 'bit', args: ['ci', 'merge', '--log', 'info'] });
  });
});
