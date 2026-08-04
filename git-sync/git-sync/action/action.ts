import { routeEvent } from '@bitdev/git-sync.git-sync.event-router';
import type { RouterInput } from '@bitdev/git-sync.git-sync.event-router';

/** Default working directory when `ws-dir` action input is unset. */
const DEFAULT_WS_DIR = '.';
/** Default branch used for main-scope sync PRs when `main-sync-branch` action input is unset. */
const DEFAULT_MAIN_SYNC_BRANCH = 'bit-sync/main';
/** Fallback default branch when the event payload has no `repository.default_branch`. */
const DEFAULT_BRANCH_FALLBACK = 'main';
/** Git identity used for commits made by the action, unless overridden via env. */
const DEFAULT_GIT_USER_NAME = 'bit-sync[bot]';
const DEFAULT_GIT_USER_EMAIL = 'bit-sync[bot]@users.noreply.github.com';

/**
 * Dependencies injected into {@link runAction} so it can be unit-tested
 * without touching the real process environment, filesystem, or spawning
 * real processes.
 */
export type ActionDeps = {
  /** The process environment (`process.env` in production). */
  env: NodeJS.ProcessEnv;
  /** Reads and parses the GitHub Actions event payload JSON file at the given path. */
  readEventFile: (path: string) => any;
  /** Runs a command, inheriting stdio, and resolves with its exit code. */
  exec: (cmd: string, args: string[]) => Promise<number>;
  /** Changes the process's working directory. Defaults to `process.chdir` when omitted. */
  chdir?: (dir: string) => void;
  /**
   * Reads a text file at `path` and returns its raw contents, or throws if it
   * doesn't exist. Used to read `workspace.jsonc` for `defaultScope` (see
   * {@link readDefaultScope}). Defaults to `fs.readFileSync(path, 'utf8')`
   * when omitted; injected separately from `readEventFile` because it reads a
   * different file, for a different purpose, and callers stub it with a
   * JSONC fixture rather than JSON.
   */
  readTextFile?: (path: string) => string;
};

/**
 * Collapses CR/LF (and other line separators) in a string destined for the
 * action log.
 *
 * The strings we log are derived from event payloads an outside party
 * controls — a bit.cloud webhook's `client_payload`, a branch name, a
 * `workflow_dispatch` input. GitHub Actions parses stdout LINE BY LINE for
 * workflow commands (`::set-output`, `::error`, `::add-mask`, ...), so a
 * payload value containing a newline could emit its own workflow command and,
 * for example, inject an output or mask/unmask values. Flattening to spaces
 * removes that channel while keeping the message readable.
 */
function forLog(value: unknown): string {
  return String(value).replace(/[\r\n\u2028\u2029]/g, ' ');
}

/** Matches the `defaultScope` field's value inside a `workspace.jsonc` document. */
const DEFAULT_SCOPE_REGEX = /"defaultScope"\s*:\s*"([^"]+)"/;

/**
 * Reads `workspace.jsonc` and extracts its `defaultScope` field via a
 * tolerant regex rather than a JSON(C) parse.
 *
 * `workspace.jsonc` is JSONC — it routinely contains `//` line comments (the
 * scaffolded default does, see this workspace's own `workspace.jsonc`) — so a
 * real `JSON.parse` throws on it more often than not. Pulling in a
 * JSONC-aware parser dependency to read a single string field used only by a
 * best-effort, fail-open relevance filter (see `isLaneRelevantToScope` in the
 * event-router) is not worth it: a regex tolerates the comments trivially and
 * finds the field wherever it sits in the document. The tradeoff is it
 * doesn't understand JSON string-escaping or structural nesting — most
 * notably, the FIRST match wins, so a commented-out `"defaultScope": "..."`
 * line earlier in the file would shadow the real one. That's an accepted,
 * documented tolerance: a wrong `repoScope` only ever makes Stage 0's filter
 * fail open (route as it did before this feature existed) or, symmetrically,
 * skip a lane that turns out to be relevant after all; either way the CLI's
 * own cross-scope halt is the real safety net, not this heuristic.
 *
 * Deliberately takes a BARE filename, not a path joined with `ws-dir`: this
 * is called from {@link buildRouterInput}, itself called from
 * {@link runAction} strictly AFTER `chdir(wsDir)` has already run (when
 * `ws-dir` is set to something other than `.`). The process's cwd is
 * therefore already `wsDir` by the time this reads, so joining `wsDir` again
 * here would double it (`<wsDir>/<wsDir>/workspace.jsonc`) and always miss.
 *
 * Returns `undefined` (never throws) on a missing file, an unreadable path,
 * or a document with no `defaultScope` field — all fail-open cases.
 */
function readDefaultScope(readTextFile: ((path: string) => string) | undefined): string | undefined {
  if (!readTextFile) return undefined;
  try {
    const text = readTextFile('workspace.jsonc');
    return text.match(DEFAULT_SCOPE_REGEX)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Builds the {@link RouterInput} the event-router expects from the GitHub
 * Actions event context: `GITHUB_EVENT_NAME` plus the JSON payload at
 * `GITHUB_EVENT_PATH`, plus `repoScope` read from `workspace.jsonc` (see
 * {@link readDefaultScope}). Must be called AFTER any `chdir(wsDir)` so the
 * bare `'workspace.jsonc'` read inside `readDefaultScope` resolves against
 * the right directory — see that function's JSDoc.
 */
function buildRouterInput(
  env: NodeJS.ProcessEnv,
  readEventFile: (path: string) => any,
  readTextFile: ((path: string) => string) | undefined
): RouterInput {
  const eventName = env.GITHUB_EVENT_NAME ?? '';
  const eventPath = env.GITHUB_EVENT_PATH;
  const payload = eventPath ? readEventFile(eventPath) : {};

  const mainSyncBranch = env['INPUT_MAIN-SYNC-BRANCH'] || DEFAULT_MAIN_SYNC_BRANCH;
  const defaultBranch = payload?.repository?.default_branch ?? DEFAULT_BRANCH_FALLBACK;

  const input: RouterInput = {
    eventName,
    defaultBranch,
    mainSyncBranch,
    repoScope: readDefaultScope(readTextFile),
  };

  switch (eventName) {
    case 'repository_dispatch':
      // repository_dispatch: payload.action is the event_type sent by the dispatcher.
      input.dispatchType = payload?.action;
      input.clientPayload = payload?.client_payload;
      break;
    case 'push':
      input.ref = payload?.ref;
      input.headCommitMessage = payload?.head_commit?.message;
      break;
    case 'pull_request':
      input.prMerged = payload?.pull_request?.merged;
      input.prHeadRef = payload?.pull_request?.head?.ref;
      // The branch the PR merged INTO. The router releases only for merges
      // into the default branch.
      input.baseRef = payload?.pull_request?.base?.ref;
      break;
    case 'workflow_dispatch':
      input.inputLane = payload?.inputs?.lane;
      break;
    default:
      break;
  }

  return input;
}

/**
 * Entry point for the `bit-git-sync` GitHub Action: switches into the
 * `ws-dir` working directory (if set to something other than `.`), normalizes
 * the current GitHub Actions event into a `bit ci` command via `routeEvent`,
 * configures the git identity used for any commits the sync makes, and runs
 * the routed command. Returns 0 without running `bit` when the event is
 * routed to a skip.
 *
 * All I/O is injected via `deps` so this function is unit-testable; `run.ts`
 * (the bundled executable entry point) wires it up with the real
 * `process.env`, `fs.readFileSync` (for both the event file and, via
 * `readTextFile`, `workspace.jsonc`), a real `process.chdir`, and a child
 * process spawn.
 */
export async function runAction(deps: ActionDeps): Promise<number> {
  const { env, readEventFile, exec, chdir = (dir: string) => process.chdir(dir), readTextFile } = deps;

  const wsDir = env['INPUT_WS-DIR'] || DEFAULT_WS_DIR;
  if (wsDir && wsDir !== '.') {
    chdir(wsDir);
  }

  // Built AFTER the chdir above: readDefaultScope (inside buildRouterInput)
  // reads a bare 'workspace.jsonc' that must resolve against the post-chdir
  // cwd, not the process's original one.
  const routerInput = buildRouterInput(env, readEventFile, readTextFile);
  const routed = routeEvent(routerInput);

  if (routed.kind === 'skip') {
    // `routed.reason` can embed payload-derived text (lane names, branch
    // names) -- see forLog on why that must not reach stdout with newlines.
    console.log(`[bit-git-sync] skipping: ${forLog(routed.reason)}`);
    return 0;
  }

  const gitUserName = env.GIT_USER_NAME || DEFAULT_GIT_USER_NAME;
  const gitUserEmail = env.GIT_USER_EMAIL || DEFAULT_GIT_USER_EMAIL;

  await exec('git', ['config', 'user.name', gitUserName]);
  await exec('git', ['config', 'user.email', gitUserEmail]);

  // `bit ci sync` is newer than the `bit ci pr` / `bit ci merge` commands, so a
  // released bit can route here and then fail with "unknown command". Probe the
  // subcommand first and name the requirement instead.
  if (routed.args[0] === 'sync' && (await exec('bit', ['ci', 'sync', '--help'])) !== 0) {
    console.error(
      '[bit-git-sync] this bit version has no "bit ci sync" command. Install a bit version that ' +
        'includes it (see the README prerequisites), then run the workflow again.'
    );
    return 1;
  }

  return exec('bit', ['ci', ...routed.args, '--log', 'info']);
}
