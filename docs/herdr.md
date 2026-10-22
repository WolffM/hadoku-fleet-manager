# herdr plugins

Two plugins live in `herdr/`, both linked from a checkout:

| plugin            | key        | what                                            |
| ----------------- | ---------- | ----------------------------------------------- |
| `hadoku.fleet`    | `prefix+m` | the fleet as herdr agents (below)               |
| `hadoku.sessions` | `prefix+/` | find a Claude session by what was typed into it |

Bind them in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "hadoku.fleet.open"

[[keys.command]]
key = "prefix+/"
type = "plugin_action"
command = "hadoku.sessions.find"
```

# hadoku.fleet — the fleet in herdr

`herdr/hadoku-fleet/` is a [herdr](https://herdr.dev) plugin that shows the
fleet as herdr agents. It is read-only: it reads mgmt-api's `GET /fleet` and
`GET /fleet/ci-state` on loopback and changes nothing.

## Use

```sh
herdr plugin link ~/repos/hadoku-fleet-manager/herdr/hadoku-fleet
herdr plugin action invoke hadoku.fleet.open
```

`open` builds a `fleet` workspace with two tabs:

| tab     | panes                                                         |
| ------- | ------------------------------------------------------------- |
| `gates` | `fleet` (budget, runner-health, roster) and `ci` (watched CI) |
| `pm2`   | one pane per pm2 host in the deployed `pm2-hosts.json`        |
| `nodes` | one pane per node in the live `/fleet` roster                 |

A second `open` focuses the existing workspace. Closing the workspace stops
every watcher; nothing keeps running after it.

The linked plugin runs this checkout, published or not, and reads its
thresholds from that checkout's `dist/`. `dist/` is gitignored and records
nothing about what it was built from, so a pull without a build would leave
the panes judging with old constants. Two guards:

- **A stale build is red.** If any `dist/` module the plugin reads is missing
  or older than its `src/` file, `open` refuses and every pane reports
  `blocked: dist/ is stale: run pnpm run build`. Once the build catches up the
  panes recover by themselves.
- **Changed code reloads.** A watcher exits with code 75 when a file it loaded
  changes on disk, and the supervisor restarts it at once without reporting a
  failure.

Every pane shows the version and commit it runs as `src`, with `+dirty` when
`herdr/`, `scripts/lib/` or `src/` has uncommitted changes.

## What the states mean

The plugin reports two states and never a third.

| state     | when                                                                                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blocked` | the server calls it a fault, degraded or unknown; a node is starved; a CI row is red or unread; the GitHub budget is under the page line; **or the plugin could not look** |
| `idle`    | everything else. A busy node is `idle` with its jobs in the message                                                                                                        |

herdr notifies on `blocked`, and shows `done` when a blocked pane returns to
`idle`, so you hear about a break and about its recovery and nothing in
between. `working` is never reported: herdr plays its "finished" sound on
every working-to-idle change, and claws make that change all day.

Every threshold is imported from the module that owns it: node severity from
the server's own `vocabulary.states[].kind`, CI staleness from `ci-alerts`,
the budget line from `gh-budget`, probe freshness from the fast loop's cadence.
The judging is in `scripts/lib/herdr-fleet.mjs`, with its tests beside it.

## pm2 panes

Each pm2 host's pane compares what the deployed tree places there with what
that host's pm2 daemon runs. Placement comes from the deployed hadoku_site
(`deploySiteRoot()`): `scripts/pm2-hosts.json` and the generated
`services/mgmt-api/deploy-config.json`, which is what mgmt-api resolves. What
runs comes from one `pm2 jlist` per host per snapshot.

It is `blocked` when:

- the host cannot be read;
- the host has not earned `pm2-capable`;
- an enabled service placed there is not online;
- a service is online there while placed on another host, which is a double
  run (for a single-writer app, two processes on one state directory).

Services with `enabled: false` and processes nothing places (a game server, a
utility) are listed and never judged.

It is not the `pm2-host` label. That label means "this box is the hub" and
routes the deploy workflows, so it is false on every other pm2 host by design.

`pm2 jlist` carries every process's environment, services' tokens included.
The list is reduced to name, status, restarts, start time and cwd ON THE HOST,
before it leaves, so neither the snapshot on disk nor any pane ever holds an
environment. A test runs the real reducer over a list with a planted secret.

Not yet built: an action that previews `service-move`. It needs a service and
a destination, and `service-move` runs from a hadoku_site worktree.

## How it is built

- **One fetch for all panes.** `GET /fleet` costs mgmt-api about 190 ms, so the
  panes share a snapshot in the plugin state dir and only one refetches per
  fast-loop tick.
- **Watchers live in their panes, not in a startup hook.** herdr's startup
  hooks are one-shot and unsupervised. herdr also drops a pane's agent the
  moment its process exits, so each watcher runs under `supervise.sh`, which
  reports a crash as `blocked` and restarts it. Ctrl+C in a pane stops both.
- **Reports carry `--seq` in epoch milliseconds.** herdr drops a report whose
  seq is older than the last one from the same source. Without it, a crash
  report was silently dropped and the dead watcher's last state stayed on screen.

# hadoku.sessions — find a Claude session

```sh
herdr plugin link ~/repos/hadoku-fleet-manager/herdr/hadoku-sessions
node herdr/hadoku-sessions/find.mjs [words]          # the same picker in any terminal
node herdr/hadoku-sessions/find.mjs --json [words]   # ranked results with liveness
node herdr/hadoku-sessions/find.mjs --enter [words]  # do what Enter would to the top hit
```

It searches what a human TYPED: prompts, pastes and `!` commands, never tool
output or injected messages. It ranks whole sessions, so a session that keeps
mentioning a word outranks one that mentions it once, and its latest title is
searchable too. Selected text seeds the query.

| row         | Enter does                                                                              |
| ----------- | --------------------------------------------------------------------------------------- |
| `● running` | selects its pane in the `claude` tmux session                                           |
| `○` dead    | opens a new window there, in the session's launch directory, and runs `claude --resume` |

A running session is never resumed a second time. A dead one is refused when
its transcript is filed under a different directory than the one it was
launched in, because `claude --resume` could not find it there.

**Where it reads.** Transcripts come from `~/.claude/projects`, which every
account dir symlinks. Liveness comes from every account's `sessions/<pid>.json`,
which counts only while that pid is alive and started when the file says.
Anything the registry misses is taken from tmux, the way
`claude-tmux-session-hook` resolves panes. The index is SQLite full-text search
at `~/.local/state/hadoku-sessions/index.db`. Transcripts only grow, so each one
is read from where the last build stopped, and a file whose first bytes changed
is read again from zero. Opening the picker brings it up to date (17-30 ms when
little changed), so nothing runs in the background.
