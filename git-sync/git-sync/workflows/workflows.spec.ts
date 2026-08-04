import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routeEvent } from '@bitdev/git-sync.git-sync.event-router';
import { TEMPLATE_FILES, REPOSITORY_DISPATCH_EVENT_TYPES, WEBHOOK_PAYLOAD_TEMPLATE } from './workflows.js';

const componentDir = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(componentDir, 'templates');

describe('TEMPLATE_FILES', () => {
  it('lists the templates that actually exist under templates/', () => {
    for (const file of TEMPLATE_FILES) {
      expect(existsSync(join(templatesDir, file))).toBe(true);
    }
  });
});

describe('template YAML invariants', () => {
  const templates = TEMPLATE_FILES.map((file) => [file, readFileSync(join(templatesDir, file), 'utf8')] as const);

  it.each(templates)('%s declares the write permissions the sync needs', (_file, text) => {
    // The default GITHUB_TOKEN is read-only on repos/orgs created after Feb
    // 2023, so an explicit block is required or the first write 403s.
    expect(text).toMatch(/^permissions:$/m);
    expect(text).toMatch(/^ {2}contents: write$/m);
    expect(text).toMatch(/^ {2}pull-requests: write$/m);
  });

  it.each(templates)('%s never cancels a run in flight', (_file, text) => {
    expect(text).toMatch(/^ {2}cancel-in-progress: false$/m);
  });

  it.each(templates)('%s marks every customer-specific literal with CHANGE-ME', (_file, text) => {
    // Each of these literals is an assumption about the customer's repo that
    // they must review. A literal without a nearby CHANGE-ME marker is a
    // silent footgun.
    for (const literal of ['bit-sync/main', 'acme/bit-git-sync@v1']) {
      expect(text).toContain(literal);
    }
    expect(text).toContain('CHANGE-ME');
  });

  it('bit-release.yml only triggers for PRs merged into the default branch', () => {
    const text = readFileSync(join(templatesDir, 'bit-release.yml'), 'utf8');
    expect(text).toMatch(/^ {4}branches: \[main\]$/m);
  });

  it('bit-sync.yml keys its concurrency group off the event name before reading github.ref_name', () => {
    // github.ref_name is populated on schedule runs too (it is the default
    // branch there), so reading it unconditionally makes the final fallback
    // unreachable and collides cron runs with default-branch pushes.
    const text = readFileSync(join(templatesDir, 'bit-sync.yml'), 'utf8');
    const group = text.slice(text.indexOf('group: >-'), text.indexOf('cancel-in-progress'));

    expect(group.indexOf("github.event_name == 'push'")).toBeLessThan(group.indexOf('github.ref_name'));
    expect(group).toContain("github.event_name == 'repository_dispatch'");
    // Both dispatch payload shapes are covered: the real contract's laneId and
    // the forward-compat aliases' lane.
    expect(group).toContain('github.event.client_payload.laneId');
    expect(group).toContain('github.event.client_payload.lane ');
  });
});

describe('WEBHOOK_PAYLOAD_TEMPLATE', () => {
  it('becomes valid JSON with the expected shape once {{...}} mustache placeholders are substituted', () => {
    const substituted = WEBHOOK_PAYLOAD_TEMPLATE.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, name) => `dummy-${name}`);

    const parsed = JSON.parse(substituted);

    expect(parsed).toEqual({
      event_type: 'bit-export',
      client_payload: {
        laneId: 'dummy-laneId',
        componentIds: 'dummy-componentIds',
        owner: 'dummy-owner',
        actor: 'dummy-username',
      },
    });
  });

  it('is also syntactically valid JSON as-authored (the {{...}} tokens sit inside quoted string values)', () => {
    // bit.cloud replaces the {{...}} tokens with real values before delivery,
    // but because each one is written inside a JSON string, the template
    // itself already parses -- it just carries placeholder text instead of
    // real data. That makes the template trivially copy/paste-able into the
    // webhook UI without tripping a client-side JSON validator.
    const parsed = JSON.parse(WEBHOOK_PAYLOAD_TEMPLATE);
    expect(parsed.client_payload.laneId).toBe('{{laneId}}');
  });
});

describe('REPOSITORY_DISPATCH_EVENT_TYPES', () => {
  // This constant, the router's switch, and the workflow template's
  // `on.repository_dispatch.types` array must all agree -- this suite
  // checks it three ways: literal equality, the template text, and the
  // router's real behavior for each type.
  const expected = ['bit-export', 'bit-lane-export', 'bit-main-export', 'bit-lane-removed'];

  it('matches the router accepted set (must stay in sync with event-router.ts)', () => {
    expect([...REPOSITORY_DISPATCH_EVENT_TYPES]).toEqual(expected);
  });

  it('matches the `on.repository_dispatch.types` line shipped in templates/bit-sync.yml', () => {
    const yamlText = readFileSync(join(templatesDir, 'bit-sync.yml'), 'utf8');
    const match = yamlText.match(/types:\s*\[([^\]]+)\]/);
    expect(match).not.toBeNull();

    const typesInTemplate = match![1].split(',').map((s) => s.trim());
    expect(typesInTemplate).toEqual([...REPOSITORY_DISPATCH_EVENT_TYPES]);
  });

  it('is exactly the set of dispatchType values that @bitdev/git-sync.git-sync.event-router routes to a run (not a skip)', () => {
    const base = { defaultBranch: 'main', mainSyncBranch: 'bit-sync/main' };

    for (const dispatchType of REPOSITORY_DISPATCH_EVENT_TYPES) {
      const routed = routeEvent({
        ...base,
        eventName: 'repository_dispatch',
        dispatchType,
        clientPayload: { laneId: 'dummy-scope/dummy-lane', lane: 'dummy-lane' },
      });
      expect(routed.kind).toBe('run');
    }

    // An event type outside the set must be a skip -- confirms the set
    // isn't just a subset of what the router accepts.
    const unknown = routeEvent({
      ...base,
      eventName: 'repository_dispatch',
      dispatchType: 'not-a-real-event-type',
    });
    expect(unknown.kind).toBe('skip');
  });
});
