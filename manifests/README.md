# manifests — TEST FIXTURES

**Production does not read these.** They are copies, kept so the moved suites can
exercise the real loaders against real manifest shapes.

The authoritative copies are `hadoku_site/scripts/admin/{fleet-runner-manifest,
fleet-runner-coverage}.json`. The CLIs that WRITE them (`reconcile
--write-coverage`, `enroll`, `bootcamp --write`, `provision`) live in this
package, but they write through `FLEET_MANIFEST_DIR`, which defaults to that
site directory. So **an edit here changes nothing live**, and an agent that
hand-edits these files has edited a fixture. The data moves into this repo at
leave-hadoku-site Phase 2, in one window with the reader, never before: two
live copies is the drift that plan exists to end.

Each fixture carries a top-level `"$fixture"` key saying so, and
`fixture-marker.test.mjs` fails if it goes missing — which is what a raw `cp`
refresh does, so the refresh below puts it back.

At runtime mgmt-api computes `manifestDir` from its own checkout root and passes
it in. That is the whole point of the injection: the path is now stated once by
the host and verified at construction, instead of being re-derived by
`resolve(__dirname, '../../../…')` in three modules whose loaders all fail soft.

## Drift

These fixtures can go stale against the real manifests, and nothing here will
say so. That is an accepted, bounded cost:

- The loaders under test are shape-driven, so a renamed claw ages a fixture
  without weakening what the suite actually checks.
- The failure this repo genuinely had to prevent — production not finding its
  manifests at all — is caught by `requirePaths()` in `host.ts`, which throws at
  construction naming every missing file. It is not caught by these fixtures.

Refresh them when a test starts asserting something the real fleet no longer has:

```bash
for f in fleet-runner-manifest fleet-runner-coverage; do
  jq --indent 2 '{"$fixture": "TEST FIXTURE. Production reads hadoku_site/scripts/admin/'"$f"'.json; edit nothing here. See manifests/README.md."} + .' \
    ../hadoku_site/scripts/admin/$f.json > manifests/$f.json
done
```

Then re-run the publish-safety guard: the site copies carry private addresses
the public fixtures must not.

They are excluded from the published package (`files` lists `dist` and
`README.md` only).

## `node-profiles.json` and `egress-slices.json` are NOT fixtures

Two files here are authoritative rather than copies, and for the same reason:
they have no writer left behind in `hadoku_site`. Nothing generates them — an
operator edits them — so `manifests/` is where they are edited and reviewed, and
`FLEET_MANIFEST_DIR` is how a run finds them. Both loaders THROW when the file is
absent rather than returning an empty set.

### `egress-slices.json`

fleet-manager's half of the split tunnel agreed with local-hawk on 2026-09-05: it
declares WHICH cgroups carry fleet work and must egress direct, and names every
PM2 app that is not an ecosystem service. `fleet egress-slices` audits the live
box against it; local-hawk owns the routing policy that acts on it.

Copy it to the manifest directory alongside the others, exactly like
`node-profiles.json`:

```bash
cp manifests/egress-slices.json ../hadoku_site/scripts/admin/
```

Do not add routing, marks, interfaces or CIDRs to it. Those are the other half of
the boundary, and local-hawk asked to be sent requirements rather than edits —
`/etc/suricata/suricata.yaml`, `zeek/*` and the NordVPN allowlist are the
instruments it reads the box through.

## `node-profiles.json` in particular

`fleet usb-prep` reads it through
`scripts/lib/node-profiles.mjs`, which resolves `FLEET_MANIFEST_DIR` exactly like
every other manifest and THROWS when the file is not there.

So `manifests/` is where it is edited and reviewed, and `FLEET_MANIFEST_DIR` is
how a run finds it:

```bash
FLEET_MANIFEST_DIR=$PWD/manifests sudo -E fleet usb-prep --list-profiles
```

If your `FLEET_MANIFEST_DIR` points at `hadoku_site/scripts/admin` (the default),
copy it there alongside the others. The loader will tell you which path it
looked at; it does not fall back to a `__dirname` walk and it does not return an
empty profile set, because a stick written from an empty profile images a node
into a shape nobody declared and prints a green summary doing it.
