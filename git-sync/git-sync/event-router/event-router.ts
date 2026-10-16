/**
 * Cross-repo constant pairing: this literal MUST stay equal to
 * `SYNC_COMMIT_MARKER` exported from the bit core repo at
 * `scopes/git/ci/sync/sync-state.ts`. Bit's sync executor stamps every
 * commit it creates with this marker (see `main-sync-executor.ts`) so the
 * event router can recognize — and skip re-triggering on — its own pushes.
 */
const BIT_SYNC_COMMIT_MARKER = '[bit-sync]';

/**
 * Normalized input the event router consumes, derived from the GitHub
 * Actions event context (`GITHUB_EVENT_NAME`, `github.event`, and workflow
 * inputs) by the calling action/workflow.
 */
export type RouterInput = {
  /** GITHUB_EVENT_NAME, e.g. 'repository_dispatch' | 'push' | 'pull_request' | 'workflow_dispatch' | 'schedule'. */
  eventName: string;
  /** repository_dispatch: payload.action holds the event_type sent by the dispatcher. */
  dispatchType?: string;
  clientPayload?: {
    /** bit.cloud webhook contract: 'scope-id/lane-name' on a lane export, '' (or absent) on a main export. */
    laneId?: string;
    /** Forward-compat alias payload shape (bit-lane-export / bit-lane-removed). */
    lane?: string;
    /**
     * bit.cloud webhook contract: comma-separated `scope/name@version` entries
     * for the components the export actually touched. Used by the
     * cross-scope-lane relevance filter (see `repoScope` below) to decide
     * whether this repo has any stake in a lane export before routing it.
     * Absent/empty is NOT a signal of anything — it just means the filter
     * can't run, so it fails open (see `isLaneRelevantToScope`). A webhook
     * created through the API, or a hand-rolled dispatch, may send an array.
     */
    componentIds?: string | string[];
  };
  /** push: refs/heads/<branch>. */
  ref?: string;
  /** push: payload.head_commit.message. */
  headCommitMessage?: string;
  /** pull_request closed: payload.pull_request.merged. */
  prMerged?: boolean;
  /** pull_request: payload.pull_request.head.ref. */
  prHeadRef?: string;
  /**
   * pull_request: payload.pull_request.base.ref — the branch the PR merged
   * INTO. Only a merge into the default branch should trigger a release;
   * merges into any other branch (a stacked/feature base) are skipped. Absent
   * means "unknown", which is treated permissively for backwards
   * compatibility.
   */
  baseRef?: string;
  /** workflow_dispatch input. */
  inputLane?: string;
  /** payload.repository.default_branch. */
  defaultBranch: string;
  /** action input, default 'bit-sync/main'. */
  mainSyncBranch: string;
  /**
   * This repo's `defaultScope`, read from `workspace.jsonc` by the action.
   * Used only by the `bit-export` cross-scope relevance filter: when set (and
   * `clientPayload.componentIds` is non-empty), a lane export none of whose
   * components' scopes match `repoScope` is skipped as irrelevant to this
   * repo — see "Cross-scope lanes" in the design spec. Absent means the
   * action couldn't determine it (e.g. no `workspace.jsonc`), in which case
   * the filter fails open: the CLI halts safely on a cross-scope lane
   * regardless.
   */
  repoScope?: string;
};

export type RoutedCommand =
  | { kind: 'run'; args: string[] } // args for: bit ci <...args>
  | { kind: 'skip'; reason: string };

function run(...args: string[]): RoutedCommand {
  return { kind: 'run', args };
}

function skip(reason: string): RoutedCommand {
  return { kind: 'skip', reason };
}

/** Extracts the branch name from a `refs/heads/<branch>` ref. */
function branchFromRef(ref: string): string {
  const prefix = 'refs/heads/';
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

/**
 * Characters a Bit lane name may contain. Anything outside this set is
 * rejected rather than passed through.
 */
const VALID_LANE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Characters a Bit scope id's segment may contain. Same character class as
 * `VALID_LANE_NAME` today (scope ids are commonly dotted, e.g.
 * `acme.cards`), but named and checked separately from the lane-name
 * check because the two parts have independent argv-injection concerns (see
 * `runSyncLaneId`) and may legitimately diverge in the future.
 */
const VALID_SCOPE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * A lane name reaches us from an externally-controlled source (a bit.cloud
 * webhook's `client_payload`, or a `workflow_dispatch` input anyone with write
 * access can type) and is then spliced into the `bit ci` argv. A name that
 * begins with `-` would be read by `bit` as a FLAG, not a positional: a lane
 * called `--all` would silently turn a one-lane sync into a full reconcile.
 * So validate before emitting argv, and skip loudly on anything unexpected.
 *
 * Note this rejects leading-dash names as a side effect of the character
 * class only if the dash is not the whole name — so the check below tests the
 * first character explicitly too.
 */
function runSyncLane(lane: string, source: string): RoutedCommand {
  if (!VALID_LANE_NAME.test(lane) || lane.startsWith('-')) {
    return skip(`invalid lane name from ${source}: ${JSON.stringify(lane)}`);
  }
  return run('sync', lane);
}

/**
 * Same argv-injection concern as `runSyncLane`, but for a full
 * scope-qualified laneId ('scope-id/lane-name') that is now passed through to
 * the CLI UNSPLIT — the core CLI accepts scope-qualified lane targets so the
 * hosting scope (which may differ from this repo's `defaultScope`) travels
 * with the lane name. Both the scope segment (before the first '/') and the
 * name segment (after it) are validated independently before the string is
 * spliced into argv, since each is an independent flag-injection vector (e.g.
 * '--evil/lane' as the scope segment).
 *
 * A laneId with no '/' at all (not expected from bit.cloud, but tolerated
 * defensively) is treated as a bare lane name.
 */
function runSyncLaneId(laneId: string, source: string): RoutedCommand {
  const idx = laneId.indexOf('/');
  if (idx === -1) return runSyncLane(laneId, source);

  const scopePart = laneId.slice(0, idx);
  const namePart = laneId.slice(idx + 1);

  if (!VALID_SCOPE_NAME.test(scopePart) || scopePart.startsWith('-')) {
    return skip(`invalid lane scope from ${source}: ${JSON.stringify(scopePart)}`);
  }
  if (!VALID_LANE_NAME.test(namePart) || namePart.startsWith('-')) {
    return skip(`invalid lane name from ${source}: ${JSON.stringify(namePart)}`);
  }
  return run('sync', laneId);
}

/**
 * Extracts the scope-id prefix (the substring before the first '/') from
 * each entry of a comma-separated `componentIds` string
 * ('scope/name@version, scope/name@version, ...'). Malformed entries (no
 * '/') are kept as-is -- they simply won't match a real `repoScope` and so
 * are harmless to the relevance check below.
 */
function scopesInComponentIds(componentIds: string): string[] {
  return componentIds
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const idx = entry.indexOf('/');
      return idx === -1 ? entry : entry.slice(0, idx);
    });
}

/**
 * Stage 0 cross-scope-lane relevance filter (see "Cross-scope lanes" in the
 * design spec). A lane hosted on some scope may carry components from many
 * scopes; this repo only has a stake in a `bit-export` dispatch if at least
 * one touched component's scope matches this repo's `defaultScope`.
 *
 * Fails OPEN whenever it can't tell: no `componentIds` (older webhook
 * payload shape, or a main export which doesn't carry them) or no
 * `repoScope` (the action couldn't read `workspace.jsonc`) both route as
 * before. That's safe, not just permissive: the CLI itself halts on a lane
 * whose content isn't entirely inside `defaultScope`, so failing open here
 * only means the halt happens in `bit ci` instead of being pre-empted here.
 */
function isLaneRelevantToScope(componentIds: string | string[] | undefined, repoScope: string | undefined): boolean {
  if (!componentIds || !repoScope) return true;
  const scopes = scopesInComponentIds(Array.isArray(componentIds) ? componentIds.join(',') : String(componentIds));
  if (scopes.length === 0) return true;
  return scopes.includes(repoScope);
}

function routeRepositoryDispatch(input: RouterInput): RoutedCommand {
  const { dispatchType, clientPayload, repoScope } = input;

  switch (dispatchType) {
    // Real bit.cloud webhook contract (empirically verified): a single
    // 'bit-export' dispatch type, discriminated by clientPayload.laneId.
    case 'bit-export': {
      if (!isLaneRelevantToScope(clientPayload?.componentIds, repoScope)) {
        return skip(`lane does not touch this repo's scope (${repoScope})`);
      }
      const laneId = clientPayload?.laneId;
      if (laneId) return runSyncLaneId(laneId, 'client_payload.laneId');
      return run('sync', '--main');
    }

    // Forward-compat aliases: kept in case a platform/webhook config still
    // sends the originally-assumed, more granular dispatch types.
    case 'bit-lane-export':
    case 'bit-lane-removed': {
      const lane = clientPayload?.lane;
      if (!lane) return skip(`repository_dispatch '${dispatchType}' missing clientPayload.lane`);
      return runSyncLane(lane, 'client_payload.lane');
    }
    case 'bit-main-export':
      return run('sync', '--main');

    default:
      return skip(`unrecognized repository_dispatch type: ${dispatchType ?? '<none>'}`);
  }
}

function routePush(input: RouterInput): RoutedCommand {
  const { ref, headCommitMessage, defaultBranch, mainSyncBranch } = input;
  if (!ref) return skip('push event missing ref');

  const branch = branchFromRef(ref);

  if (headCommitMessage?.includes(BIT_SYNC_COMMIT_MARKER)) {
    return skip('push is one of bit-sync own commits');
  }
  if (branch === defaultBranch) {
    return skip(`push to default branch '${defaultBranch}'`);
  }
  if (branch === mainSyncBranch) {
    return skip(`push to main sync branch '${mainSyncBranch}'`);
  }

  return run('sync', '--branch', branch);
}

function routePullRequest(input: RouterInput): RoutedCommand {
  const { prMerged, prHeadRef, baseRef, defaultBranch, mainSyncBranch } = input;

  if (!prMerged) return skip('pull_request closed without merging');
  if (prHeadRef === mainSyncBranch) {
    return skip('merged main-sync PR: nothing to release, scope is already ahead');
  }
  // `bit ci merge` releases from the default branch. A PR merged into some
  // other base (a stacked PR, a release train, a docs branch) has not landed
  // on the default branch yet, so releasing here would tag work that is not
  // actually on main. `baseRef` absent means the caller could not determine
  // the base -- stay permissive there and behave as before.
  if (baseRef !== undefined && baseRef !== defaultBranch) {
    return skip(`merged PR targets '${baseRef}', not the default branch '${defaultBranch}'`);
  }
  return run('merge');
}

function routeWorkflowDispatch(input: RouterInput): RoutedCommand {
  // Same argv-injection concern as the webhook lane names: `inputLane` is
  // free text typed into the "Run workflow" form. Routed through the laneId
  // variant because the form legitimately accepts the same scope-qualified
  // ids the webhook sends ('scope-id/lane-name') — e.g. to target a lane
  // hosted on a scope other than the repo's defaultScope, which is how the
  // cross-scope refusal is exercised by hand.
  return input.inputLane ? runSyncLaneId(input.inputLane, 'workflow_dispatch input') : run('sync', '--all');
}

/**
 * Maps a normalized GitHub Actions event into the `bit ci` command that
 * should run in response, or a `skip` with a human-readable reason when no
 * action is needed (e.g. the event was produced by bit-sync itself).
 */
export function routeEvent(input: RouterInput): RoutedCommand {
  switch (input.eventName) {
    case 'repository_dispatch':
      return routeRepositoryDispatch(input);
    case 'push':
      return routePush(input);
    case 'pull_request':
      return routePullRequest(input);
    case 'workflow_dispatch':
      return routeWorkflowDispatch(input);
    case 'schedule':
      return run('sync', '--all');
    default:
      return skip(`unrecognized event: ${input.eventName}`);
  }
}
