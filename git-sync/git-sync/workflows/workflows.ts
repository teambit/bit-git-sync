/**
 * File names of the shippable GitHub Actions workflow templates this
 * component ships, relative to its `templates/` directory. Customers copy
 * these into their own repository's `.github/workflows/`.
 */
export const TEMPLATE_FILES = ['bit-sync.yml', 'bit-release.yml'] as const;

/**
 * The full set of `repository_dispatch` event types the bit-git-sync event
 * router recognizes (`routeRepositoryDispatch` in
 * `@bitdev/git-sync.git-sync.event-router`'s `event-router.ts`).
 *
 * `'bit-export'` is the real, empirically-verified bit.cloud webhook
 * contract: a single dispatch type discriminated by
 * `client_payload.laneId` (non-empty `'scope/lane'` -> lane export, empty ->
 * main export). The other three (`'bit-lane-export'`, `'bit-main-export'`,
 * `'bit-lane-removed'`) are forward-compat aliases the router also accepts,
 * kept in case a webhook is ever configured to send the originally-assumed,
 * more granular dispatch types instead. There is no real `'bit-lane-removed'`
 * bit.cloud event -- lane deletions are picked up by the scheduled reconcile
 * run instead.
 *
 * IMPORTANT: this list must be kept in sync with the `switch` in
 * `routeRepositoryDispatch` (event-router.ts) and with the
 * `on.repository_dispatch.types` array in `templates/bit-sync.yml`. This
 * component's spec cross-checks it against the router's actual behavior by
 * importing `routeEvent` directly.
 */
export const REPOSITORY_DISPATCH_EVENT_TYPES = [
  'bit-export',
  'bit-lane-export',
  'bit-main-export',
  'bit-lane-removed',
] as const;

/**
 * The canonical bit.cloud webhook "Custom" payload template, verified
 * empirically against a live bit.cloud org's "Components -> Export
 * succeeded" webhook (see `workflows.docs.mdx` for the full setup
 * walk-through). Customers paste this exact string into the webhook's
 * custom payload template field.
 *
 * bit.cloud substitutes the `{{...}}` placeholders (mustache-style) before
 * delivering the POST body, so this string is only valid JSON *after* that
 * substitution -- not as written.
 */
export const WEBHOOK_PAYLOAD_TEMPLATE =
  '{"event_type":"bit-export","client_payload":{"laneId":"{{laneId}}","componentIds":"{{componentIds}}","owner":"{{owner}}","actor":"{{username}}"}}';
