# bit-git-sync

A GitHub Action that keeps a Bit scope and a git repository equal. The action runs `bit ci sync`,
`bit ci pr`, or `bit ci merge`. The event decides which command runs.

One repository maps to one scope. A change can start on either side:

| Direction | What happens |
| --- | --- |
| A person exports a lane on bit.cloud | The action creates a branch and a pull request in this repository. |
| A person commits on that branch | The action snaps the commit onto the lane. |
| A person merges the pull request | The action merges the lane, then tags and exports the versions. |
| A person opens an ordinary git pull request | The action adopts the pull request into a lane. |

## Prerequisite: a bit version that has `bit ci sync`

The `bit ci pr` and `bit ci merge` commands are in every current release. The `bit ci sync` command
is not: it arrives with [teambit/bit#10541](https://github.com/teambit/bit/pull/10541). Bit 2.0.63
does not have the command.

If the workflow runs a sync on a bit version without the command, the action stops and names the
requirement. It does not fail with an unclear error.

Until the pull request is in a release, install a build that contains it, and tell
`bit-tasks/init` to skip its own installation:

```yaml
      - name: Install a bit version with bit ci sync
        run: |
          npm i -g @teambit/bvm
          # A snap build of the merge commit, or the first release after it.
          bvm install <version>
          echo "$HOME/bin" >> $GITHUB_PATH
      - uses: bit-tasks/init@v2
        with:
          skip-bit-install: 'true'
```

`npm view @teambit/bit dist-tags` lists the available channels. The `snap` tag holds a build for a
single commit.

## Use the action

Add a workflow that runs the action. The action reads the event and selects the command.

```yaml
name: bit-sync
on:
  repository_dispatch:
    types: [bit-export]
  push:
    branches-ignore: ['main', 'bit-sync/**']
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:
    inputs:
      lane:
        description: 'Lane to sync. Leave empty to sync every mapped lane.'
        required: false
permissions:
  contents: write
  pull-requests: write
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: teambit/bit-git-sync@<commit-sha>
        env:
          BIT_CONFIG_ACCESS_TOKEN: ${{ secrets.BIT_CONFIG_ACCESS_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Pin the action to a commit SHA. A tag can move, and this workflow holds write permission.

The command `bit ci sync --init` writes a complete pair of workflow files, and prints the remaining
setup steps.

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `ws-dir` | `.` | The directory of the Bit workspace, relative to the repository root. |
| `main-sync-branch` | `bit-sync/main` | The branch for main-scope sync pull requests. The value must match `sync.mainSyncBranch` in `workspace.jsonc`. |

### Environment

| Variable | Purpose |
| --- | --- |
| `BIT_CONFIG_ACCESS_TOKEN` | A bit.cloud token. Store the token on one line. |
| `GITHUB_TOKEN` | A token for the pull request operations. A personal access token makes the sync pushes start other workflows. |

## Which command the action runs

| Event | Command |
| --- | --- |
| `repository_dispatch` `bit-export`, with a `laneId` | `bit ci sync <scope/lane>` |
| `repository_dispatch` `bit-export`, with an empty `laneId` | `bit ci sync --main` |
| `push` to a branch | `bit ci sync --branch <branch>` |
| `pull_request` closed and merged into the default branch | `bit ci merge` |
| `schedule`, or `workflow_dispatch` with no lane | `bit ci sync --all` |
| `workflow_dispatch` with a lane | `bit ci sync <lane>` |

The router skips three classes of event. It skips a push of a commit that carries the `[bit-sync]`
marker, because the reconciler wrote that commit. It skips an export whose components belong to
another scope. It skips a lane name that git or Bit would read as an option.

## The webhook on bit.cloud

Open the scope settings, then Webhooks. Select the **Export succeeded** event. Send the webhook to
the repository dispatch endpoint:

```
POST https://api.github.com/repos/<owner>/<repo>/dispatches
Authorization: Bearer <token with repo scope>
Accept: application/vnd.github+json
Content-Type: application/json
```

Use this payload template. The `laneId` field is empty for a main export:

```json
{
  "event_type": "bit-export",
  "client_payload": {
    "owner": "{{owner}}",
    "componentIds": "{{componentIds}}",
    "username": "{{username}}",
    "userId": "{{userId}}",
    "laneId": "{{laneId}}"
  }
}
```

After you save the webhook, export a lane. Then open the delivery log. A correct delivery returns
`204`. A `401` or a `404` means the token or the headers are wrong, and no workflow starts.

## Example repository

[teambit/bit-git-sync-example](https://github.com/teambit/bit-git-sync-example) holds a complete
workspace, both workflows, and a setup script. Clone the example, point it at your own scope, and
run the four flows.

## Develop the action

The action is a set of Bit components in `git-sync/`. The event router is pure: it turns an event
into command arguments and holds no I/O.

```bash
bit install
bit compile
bit test                     # unit tests for the components
npm run bundle-action        # rebuild dist/index.js with esbuild
npm run verify-bundle        # assert the bundle is fresh and loads under Node ESM
```

Commit `dist/index.js`. GitHub runs the bundle, and `verify-bundle` fails when the bundle and the
sources differ.
