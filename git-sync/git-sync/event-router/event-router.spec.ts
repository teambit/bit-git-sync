import { routeEvent } from './event-router.js';

const base = { defaultBranch: 'main', mainSyncBranch: 'bit-sync/main' };

describe('routeEvent', () => {
  describe('repository_dispatch: bit-export (real bit.cloud webhook contract)', () => {
    it('routes bit-export with a laneId to sync <full scope-qualified laneId>', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          clientPayload: { laneId: 'acme.shop/probe-lane' },
        })
      ).toEqual({ kind: 'run', args: ['sync', 'acme.shop/probe-lane'] });
    });

    it('routes bit-export with an empty laneId to sync --main', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          clientPayload: { laneId: '' },
        })
      ).toEqual({ kind: 'run', args: ['sync', '--main'] });
    });

    it('routes bit-export with an absent laneId to sync --main', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          clientPayload: {},
        })
      ).toEqual({ kind: 'run', args: ['sync', '--main'] });
    });
  });

  describe('repository_dispatch: bit-export cross-scope relevance filter (Stage 0)', () => {
    it('routes when componentIds includes an entry whose scope matches repoScope', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          repoScope: 'acme.cards',
          clientPayload: {
            laneId: 'acme.cards/cross-scope',
            componentIds: 'acme.cards/foo@1.0.0,acme.shop/bar@2.0.0',
          },
        })
      ).toEqual({ kind: 'run', args: ['sync', 'acme.cards/cross-scope'] });
    });

    it('skips when no componentIds entry touches repoScope', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          repoScope: 'acme.cards',
          clientPayload: {
            laneId: 'acme.cards/cross-scope',
            componentIds: 'acme.shop/bar@2.0.0,acme.other/baz@1.0.0',
          },
        })
      ).toEqual({
        kind: 'skip',
        reason: "lane does not touch this repo's scope (acme.cards)",
      });
    });

    it('fails open (routes) when componentIds is absent, even with repoScope set', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          repoScope: 'acme.cards',
          clientPayload: { laneId: 'acme.cards/cross-scope' },
        }).kind
      ).toBe('run');
    });

    it('fails open (routes) when componentIds is an empty string, even with repoScope set', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          repoScope: 'acme.cards',
          clientPayload: { laneId: 'acme.cards/cross-scope', componentIds: '' },
        }).kind
      ).toBe('run');
    });

    it('fails open (routes) when repoScope is unset, even with componentIds present', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          clientPayload: {
            laneId: 'acme.cards/cross-scope',
            componentIds: 'acme.shop/bar@2.0.0',
          },
        }).kind
      ).toBe('run');
    });

    it('the filter runs before laneId routing: an irrelevant lane is skipped even if the laneId itself would validate fine', () => {
      const routed = routeEvent({
        ...base,
        eventName: 'repository_dispatch',
        dispatchType: 'bit-export',
        repoScope: 'acme.cards',
        clientPayload: {
          laneId: 'acme.cards/perfectly-valid-lane-name',
          componentIds: 'acme.shop/bar@2.0.0',
        },
      });
      expect(routed.kind).toBe('skip');
    });

    it('a namespaced component id\'s scope is the substring before its FIRST "/" (not the whole path)', () => {
      // 'acme.shop/ui/button@1.0.0' is scope 'acme.shop', name
      // 'ui/button' -- component names can themselves contain '/'.
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          repoScope: 'acme.shop',
          clientPayload: {
            laneId: 'acme.shop/cross-scope',
            componentIds: 'acme.shop/ui/button@1.0.0',
          },
        }).kind
      ).toBe('run');
    });

    it('tolerates comma+space separation between componentIds entries', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          repoScope: 'acme.cards',
          clientPayload: {
            laneId: 'acme.cards/cross-scope',
            componentIds: 'acme.other/foo@1.0.0, acme.cards/bar@1.0.0',
          },
        }).kind
      ).toBe('run');
    });
  });

  describe('repository_dispatch: bit-export scope-qualified laneId validation', () => {
    it('passes the full scope-qualified laneId through to argv unsplit', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          clientPayload: { laneId: 'acme.cards/cross-scope' },
        })
      ).toEqual({ kind: 'run', args: ['sync', 'acme.cards/cross-scope'] });
    });

    it('skips a laneId whose scope segment would be read by `bit` as a flag', () => {
      const routed = routeEvent({
        ...base,
        eventName: 'repository_dispatch',
        dispatchType: 'bit-export',
        clientPayload: { laneId: '--evil/lane' },
      });
      expect(routed).toEqual({
        kind: 'skip',
        reason: 'invalid lane scope from client_payload.laneId: "--evil"',
      });
    });
  });

  describe('repository_dispatch: forward-compat aliases', () => {
    it('routes bit-lane-export dispatch to sync <lane>', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-lane-export',
          clientPayload: { lane: 'feature-x' },
        })
      ).toEqual({ kind: 'run', args: ['sync', 'feature-x'] });
    });

    it('routes bit-main-export dispatch to sync --main', () => {
      expect(routeEvent({ ...base, eventName: 'repository_dispatch', dispatchType: 'bit-main-export' })).toEqual({
        kind: 'run',
        args: ['sync', '--main'],
      });
    });

    it('routes bit-lane-removed dispatch to sync <lane>', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-lane-removed',
          clientPayload: { lane: 'feature-x' },
        })
      ).toEqual({ kind: 'run', args: ['sync', 'feature-x'] });
    });

    it('skips a lane whose name would be read by `bit` as a flag', () => {
      // laneId 'scope/--all' would otherwise emit `bit ci sync --all`, turning
      // a single-lane sync into a full reconcile.
      const routed = routeEvent({
        ...base,
        eventName: 'repository_dispatch',
        dispatchType: 'bit-export',
        clientPayload: { laneId: 'scope/--all' },
      });
      expect(routed).toEqual({ kind: 'skip', reason: 'invalid lane name from client_payload.laneId: "--all"' });
    });

    it('skips an alias-payload lane whose name would be read by `bit` as a flag', () => {
      const routed = routeEvent({
        ...base,
        eventName: 'repository_dispatch',
        dispatchType: 'bit-lane-export',
        clientPayload: { lane: '--main' },
      });
      expect(routed).toEqual({ kind: 'skip', reason: 'invalid lane name from client_payload.lane: "--main"' });
    });

    it.each([
      ['a space', 'scope/my lane'],
      ['a shell metacharacter', 'scope/lane;rm -rf /'],
      ['a nested slash', 'scope/sub/lane/'],
      ['a newline', 'scope/lane\n::add-mask::x'],
    ])('skips a laneId containing %s', (_label, laneId) => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          clientPayload: { laneId },
        }).kind
      ).toBe('skip');
    });

    it('still accepts the dots, dashes and underscores real lane names (and scope ids) use', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'bit-export',
          clientPayload: { laneId: 'my.scope/feat_x-2.0' },
        })
      ).toEqual({ kind: 'run', args: ['sync', 'my.scope/feat_x-2.0'] });
    });

    it('skips an unknown dispatch type', () => {
      expect(
        routeEvent({
          ...base,
          eventName: 'repository_dispatch',
          dispatchType: 'some-other-event',
        }).kind
      ).toBe('skip');
    });
  });

  it('routes schedule to sync --all', () => {
    expect(routeEvent({ ...base, eventName: 'schedule' })).toEqual({ kind: 'run', args: ['sync', '--all'] });
  });

  it('routes push on a branch to sync --branch', () => {
    expect(routeEvent({ ...base, eventName: 'push', ref: 'refs/heads/feature-x', headCommitMessage: 'wip' })).toEqual(
      {
        kind: 'run',
        args: ['sync', '--branch', 'feature-x'],
      }
    );
  });

  it('skips push of its own sync commits', () => {
    const routed = routeEvent({
      ...base,
      eventName: 'push',
      ref: 'refs/heads/feature-x',
      headCommitMessage: 'chore(bit-sync): x\n\n[bit-sync]',
    });
    expect(routed.kind).toBe('skip');
  });

  it('skips push to the default branch and to the main sync branch', () => {
    expect(routeEvent({ ...base, eventName: 'push', ref: 'refs/heads/main', headCommitMessage: 'x' }).kind).toBe(
      'skip'
    );
    expect(
      routeEvent({ ...base, eventName: 'push', ref: 'refs/heads/bit-sync/main', headCommitMessage: 'x' }).kind
    ).toBe('skip');
  });

  it('routes merged PR to ci merge', () => {
    expect(routeEvent({ ...base, eventName: 'pull_request', prMerged: true, prHeadRef: 'feature-x' })).toEqual({
      kind: 'run',
      args: ['merge'],
    });
  });

  it('routes a PR merged INTO the default branch to ci merge', () => {
    expect(
      routeEvent({
        ...base,
        eventName: 'pull_request',
        prMerged: true,
        prHeadRef: 'feature-x',
        baseRef: 'main',
      })
    ).toEqual({ kind: 'run', args: ['merge'] });
  });

  it('skips a PR merged into a branch other than the default branch', () => {
    // A stacked PR landing on another feature branch has not reached main, so
    // releasing from it would tag work that is not on the default branch.
    expect(
      routeEvent({
        ...base,
        eventName: 'pull_request',
        prMerged: true,
        prHeadRef: 'feature-x-part-2',
        baseRef: 'feature-x',
      })
    ).toEqual({
      kind: 'skip',
      reason: "merged PR targets 'feature-x', not the default branch 'main'",
    });
  });

  it('respects a non-"main" default branch when checking the PR base', () => {
    const trunk = { defaultBranch: 'trunk', mainSyncBranch: 'bit-sync/main' };
    expect(
      routeEvent({ ...trunk, eventName: 'pull_request', prMerged: true, prHeadRef: 'feature-x', baseRef: 'trunk' }).kind
    ).toBe('run');
    expect(
      routeEvent({ ...trunk, eventName: 'pull_request', prMerged: true, prHeadRef: 'feature-x', baseRef: 'main' }).kind
    ).toBe('skip');
  });

  it('skips merged main-sync PR (nothing to release; scope already ahead)', () => {
    expect(
      routeEvent({ ...base, eventName: 'pull_request', prMerged: true, prHeadRef: 'bit-sync/main' }).kind
    ).toBe('skip');
  });

  it('skips closed-unmerged PRs', () => {
    expect(routeEvent({ ...base, eventName: 'pull_request', prMerged: false, prHeadRef: 'feature-x' }).kind).toBe(
      'skip'
    );
  });

  it('routes workflow_dispatch with and without a lane', () => {
    expect(routeEvent({ ...base, eventName: 'workflow_dispatch', inputLane: 'feature-x' })).toEqual({
      kind: 'run',
      args: ['sync', 'feature-x'],
    });
    expect(routeEvent({ ...base, eventName: 'workflow_dispatch' })).toEqual({ kind: 'run', args: ['sync', '--all'] });
  });

  it('skips a workflow_dispatch lane input that would be read by `bit` as a flag', () => {
    expect(routeEvent({ ...base, eventName: 'workflow_dispatch', inputLane: '--main' })).toEqual({
      kind: 'skip',
      reason: 'invalid lane name from workflow_dispatch input: "--main"',
    });
  });

  it('accepts a scope-qualified workflow_dispatch lane input, unsplit (same grammar as the webhook laneId)', () => {
    expect(routeEvent({ ...base, eventName: 'workflow_dispatch', inputLane: 'acme.cards/cross-scope' })).toEqual({
      kind: 'run',
      args: ['sync', 'acme.cards/cross-scope'],
    });
  });

  it('skips a scope-qualified workflow_dispatch input whose scope segment would be read as a flag', () => {
    expect(routeEvent({ ...base, eventName: 'workflow_dispatch', inputLane: '--evil/lane' })).toEqual({
      kind: 'skip',
      reason: 'invalid lane scope from workflow_dispatch input: "--evil"',
    });
  });
});
