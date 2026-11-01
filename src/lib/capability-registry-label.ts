/**
 * The `surface: 'label'` capability entries — wave 5r lane D split of
 * `capability-registry.ts`, data moved out as a pure move so the registry
 * file falls under the 800-line source ceiling.
 *
 * Every entry here is declared in `machines[].labels`, projected onto every
 * runner the node hosts, and routable by a workflow's `runs-on`. See
 * `capability-registry.ts` for `CapabilitySurface`'s own doc and for
 * `BUILDER_LABEL`/`PM2_HOST_LABEL`/`BACKSTOP_LABEL`/`MUST_BE_EPHEMERAL`/
 * `THROTTLE_FIELDS`, which live in `capability-registry-ids.ts` so this
 * module and the main one are not circular imports of each other.
 */

import type { Capability } from './capability-registry.js';
import {
	BACKSTOP_LABEL,
	BUILDER_LABEL,
	MUST_BE_EPHEMERAL,
	PM2_HOST_LABEL,
	THROTTLE_FIELDS,
} from './capability-registry-ids.js';

export const BUILDER_LABEL_CAPABILITY: Capability = {
	id: BUILDER_LABEL,
	label: 'General CI',
	kind: 'eligibility',
	surface: 'label',
	verify: 'role',
	description:
		'General CI eligibility. THE routing lever: GitHub has no runner priority, so the ' +
		'fast loop adds and removes this label every few minutes to decide which nodes ' +
		'GitHub can see at all. A node without it is invisible, not broken.',
	rung: 2,
	requires: { fields: THROTTLE_FIELDS },
};
export const PM2_HOST_CAPABILITY: Capability = {
	id: PM2_HOST_LABEL,
	label: 'Production PM2 host',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'THE box that hosts the PM2 production stack — not a box that COULD. Runs mgmt-api, ' +
		'the tunnel and the other production services, and serves the six infra workflows that carry ' +
		'`runs-on: [self-hosted, pm2-host]` (redeploy-mgmt-api, redeploy-service, ' +
		'reload-ecosystem, cron-schedules-sync, recreate-pm2-registrations, ' +
		'temporal-cluster-diag). Top rung of the priority ladder — see {@link ladder}, which ' +
		'derives it from `rung` so this text does not carry a fifth prose copy — so a busy ' +
		'runner carrying it means CI must not add load on top. ' +
		'PROVEN BY EXECUTION since 2026-09-15 (#6) and NARROWED 2026-09-26 (wave 3o): the ' +
		'probe confirms a pm2 daemon is ALIVE under the DEFAULT PM2_HOME — from its pid file ' +
		'and socket, before pm2 is run at all, because `pm2 jlist` LAUNCHES a daemon where ' +
		'none is running — and that it reports at least one app `online`. The narrowing is ' +
		'not tidying: the 2026-09-15 probe answered "is pm2 installed and can it supervise ' +
		'under a throwaway home", which is the CAPABILITY, and {@link nodeOffer} puts every ' +
		'earned identity label onto a node’s registrations and JIT mints. A claw proving it ' +
		'would have started answering redeploy-mgmt-api on a box with no ecosystem file and ' +
		'no vault, left `census.clawPool` (which subtracts this label) silently short, and ' +
		'made `census.pm2Busy` read a busy claw as the production host being busy. The ' +
		'capability question moved to {@link CAPABILITIES} entry `pm2-capable`, which is ' +
		'`surface: "implicit"` and therefore routable by nothing. ' +
		'It read `verify: "role"` before #6, with "the fleet’s own topology is the ' +
		'evidence" beside it, which was true of exactly one machine — and that machine is a ' +
		'backstop. THE DECLARED PATH IS RETIRED FOR EVERY NODE: nothing can type its way ' +
		'in, because `nodeOffer` REPLACES a declared probe-verified label with the proof ' +
		'record. (Until 2026-10-31 the backstop kept its declaration by role; its own ' +
		'bootcamp record now earns `pm2-host`.) Measured 2026-09-26: ' +
		'`ok 24-online` on hokon, `no absent` on all eight claws.',
	rung: 1,
	requires: {
		fields: [
			{
				field: 'minFreeMb',
				why:
					'the production host reserves headroom for mgmt-api, the tunnel and the other production services ' +
					'against the CI it now also hosts. Undefined becomes MIN_FREE_MB=0 in the ' +
					'generated throttle config, which removes exactly that protection.',
			},
		],
	},
};
export const TASKAUTO_CAPABILITY: Capability = {
	/*
	 * THE FIRST WORKLOAD LEAVING THE BACKSTOP, AND IT IS NOT SIZED BY THE ROLE ABOVE.
	 *
	 * `pm2-capable`'s bar is 9,784 MiB because a placement establishing a ROLE
	 * is sized against the role. `taskauto` is one small TENANT of that role,
	 * and sizing a tenant by its landlord is what produced wave 3o's "NO BOX
	 * TODAY" with claw-9 missing on margin at 1.18x. Measured per job on
	 * claw-8 2026-09-28 (`taskauto-onto-a-claw-2026-09-28.md` §1.3):
	 * `drain the board` peaks at 517 MiB, 12.3 s of CPU, zero OOM kills —
	 * 19x under the role figure and 27x under claw-8's 13,867 MiB slice
	 * ceiling, so the margin question does not arise for this tenant at all.
	 *
	 * NO BAR IS DECLARED HERE, DELIBERATELY. 517 MiB would admit every box in
	 * the fleet including the two 7.8 GB claws that `pm2-capable` refuses, so
	 * a `measure` would be a bar that discriminates nothing while reading as
	 * though it had been considered. The number belongs in the doc that
	 * measured it until a node is actually rejected by it.
	 *
	 * WHAT THE LABEL DOES NOT CARRY, measured the same day: the host plumbing.
	 * `pm2` is NOT among it — neither `taskauto.yml`'s `drain the board` nor
	 * `test.yml`'s `backend pytest` invokes pm2 anywhere, so `pm2-host` in
	 * their `runs-on` is routing and nothing else. What IS needed beyond
	 * python-venv and gh is a tokenless `~/.npmrc` (no secret, expands
	 * `${NODE_AUTH_TOKEN}` from the job env) and the `claude` binary at
	 * `TASKAUTO_CLAUDE_BIN`, which NO claw carried on 2026-09-28. The
	 * `~/.bashrc` vault export is not needed and never was: it sits after the
	 * interactive guard, which is why the workflow passes the token as a job
	 * env var instead.
	 */
	id: 'taskauto',
	label: 'Task automation',
	kind: 'identity',
	surface: 'label',
	verify: 'role',
	description:
		'Scheduled task automation — tenhands’ board sweep and its backend suite. ' +
		'Bottom rung of the priority ladder, yielded to both CI and pm2-host work. ' +
		'288 jobs / 1.87 h in the 14 days to 2026-09-28, every one of them served by the ' +
		'backstop’s registration; 517 MiB peak per job, measured on claw-8, which is ' +
		'a NINETEENTH of the pm2-host role figure `pm2-capable` carries above.',
	rung: 3,
	// `backend pytest` is the job that EXERCISES the LLM judge (`taskauto.yml`'s
	// own sweep exits at "nothing to drive" on an empty board and never invokes
	// `claude`). Its `Require the claude CLI on PATH` step prints
	// `claude resolved to <path>`, and pytest's summary line carries the
	// pass/skip counts — a judge test skipped for want of the token reads as
	// `skipped`, which is why the evidence asks for both.
	jobProof: {
		repo: 'WolffM/hadoku-tenhands',
		workflow: 'test.yml',
		job: 'backend pytest',
		evidence: 'claude resolved|\\d+ passed|\\d+ skipped|\\d+ deselected',
	},
};
export const AV1_NVENC_CAPABILITY: Capability = {
	id: 'av1-nvenc',
	label: 'NVENC AV1 encode',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'Hardware AV1 encoding through NVENC. One node deep, and the reason 22 ' +
		'dataplatform tests skip when hokon is dark.',
};
/*
 * THE REST OF THE GPU FAMILY, ADDED 2026-09-08 (WS-N) WITH THE ARRIVAL OF
 * claw-7 (Maxwell GM200) AND claw-8 (Turing TU104).
 *
 * `surface: 'implicit'` — PROBED, DECLARED BY NOBODY, ROUTABLE BY NOTHING. That
 * is the documented meaning of the surface and `jitconfig` is the precedent:
 * measured because the answer matters, not exposed because no workflow asks.
 *
 * It is also the only honest option, and the test suite is what made that
 * concrete. Registering these as `label` failed two invariants at once: every
 * label capability must be declared by some node (they are declared by none,
 * and could not be — the boxes did not exist yet), and a watched label nothing
 * offers pages forever. Declaring them on claw-7/claw-8 up front to satisfy the
 * first would have been precisely what node-profiles.json's gpu.$why-no-labels
 * forbids: a claim entered before anything proved it. The 2026-09-07 settled
 * decision says capabilities are DERIVED from what a box proves and the required
 * set is the union of what covered repos actually ask for — and no covered repo
 * asks for GPU work today.
 *
 * SO THIS IS THE MEASUREMENT, HELD ONE STEP SHORT OF BEING A ROUTING LEVER.
 * When a real workload wants a GPU, promoting one of these to `surface: 'label'`
 * is a deliberate, reviewed, one-line change made against probe output that
 * already exists — instead of a guess made today about hardware nobody has
 * booted.
 *
 * `nvenc-h264` WAS THE FIRST TO TAKE THAT STEP, 2026-10-23 (fleet-manager#3):
 * hadoku-watchparty's ingest encodes with `h264_nvenc` and moved from a child
 * process of its server to a fleet job. Its entry carries why.
 *
 * The honest expected answers on the two new cards, so nobody reads a `no` as a
 * regression: NVENC AV1 encode arrived with Ada (RTX 40), so `av1-nvenc` is NO
 * on both. H.264 and HEVC are YES on both. And every one of them is NO on an
 * unrebooted box, because the DKMS module is not in the running kernel yet.
 */
export const NVENC_H264_CAPABILITY: Capability = {
	/*
	 * PROMOTED TO A LABEL 2026-10-23 (fleet-manager#3), against probe output that
	 * already existed: bootcamp had earned it on hokon (10-09), claw-1 (10-10),
	 * claw-8 and claw-9 (10-06). No `nodeOffer` change came with it — every
	 * earned identity label is offered, on the backstop too, which is how hokon
	 * already carried `jdk21`.
	 *
	 * FOUR NODES DEEP, ON PURPOSE. watchparty's ingest needs only H.264, so
	 * any of them can encode. What it also needs is the data endpoint's
	 * admission, a separate question with its own label (`data-peer`).
	 * Narrowing this label to hokon would make an encoder capability lie
	 * about the nodes that have it.
	 */
	id: 'nvenc-h264',
	label: 'NVENC H.264 encode',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'Hardware H.264 encoding through NVENC. The broadest NVENC codec — every ' +
		'NVIDIA card the fleet owns can do it, back to Maxwell. Routed on by ' +
		'watchparty’s ingest, alongside `data-peer`.',
};
export const DATA_PEER_CAPABILITY: Capability = {
	/*
	 * ADMISSION, NOT A TOOL — proved by connecting, never by a membership list.
	 *
	 * dataplatform's data listener refuses a peer it has not admitted BEFORE it
	 * reads a key, so "can encode" plus a key is not enough. It replaced
	 * `watchparty-media` (a host pin by data locality) on 2026-10-28, once the
	 * library moved into the endpoint. Before #28 the refusal was a bare 404:
	 * watchparty's ingest landed on claw-1 and every call 404'd (run
	 * 40639427546, fleet-manager#16). Who is admitted is dataplatform's
	 * decision (hadoku-dataplatform#28); this only READS the outcome, from the
	 * node, the way the job will meet it. An unkeyed request is 401 to an
	 * admitted peer, and nothing answers 401 before the peer check
	 * (dataplatform data/AGENTS.md). A refused one gets 403 `peer not
	 * admitted` (a bare 404 before 2026-10-28). So no secret is needed.
	 *
	 * The endpoint is the controller's to name (`probe-script.mjs`), because
	 * its address is private and this repo is public. A probe run without it
	 * prints nothing for this label, which is "not judged", never "no".
	 */
	id: 'data-peer',
	label: 'Admitted by the data endpoint',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'dataplatform’s data listener admits this node as a peer: an unkeyed request ' +
		'from the node gets the 401 an admitted peer gets, not the bare 404 a refused ' +
		'one does. Routed on by any job that reads or writes the data endpoint.',
};
export const SERVICE_HOST_CAPABILITY: Capability = {
	/*
	 * CAN SERVE A PLACED SERVICE — proved on the node, never read from a list.
	 *
	 * fleet-manager#16: the fleet places `kind: service` tenants itself, and
	 * hadoku_site can deploy one only to a node with the tenant toolchain on
	 * the PATH sudo gives a tenant, its own cloudflared tunnel up, and a
	 * service state root (hadoku_site docs/operations/MULTI_HOST_PM2.md,
	 * service-move gatherFacts()). Which nodes hadoku_site deploys to is its
	 * call (pm2-hosts.json); this reads whether the node CAN, the way
	 * `data-peer` reads the listener's verdict. Not `pm2-host`, which means
	 * the HUB and is hokon's alone: gating on it would rule out claw-6.
	 *
	 * The evidence is the tunnel ID, for hadoku_site's drift gate. Readiness
	 * of one tenant on the node (its user, pm2, clone, ingress rule) is
	 * `hosting --check`'s, since it cannot be known before the tenant exists.
	 */
	id: 'service-host',
	label: 'Can serve a placed pm2 service',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'A tenant’s toolchain (pm2, node, git, curl, rsync, pnpm, python3 with venv) on ' +
		'the PATH sudo hands a tenant, this node’s own cloudflared tunnel ready, and ' +
		'the service state root present. Required of a node before the fleet places a ' +
		'`kind: service` tenant there.',
};
export const JIT_CANARY_CAPABILITY: Capability = {
	id: 'jit-canary',
	label: 'JIT runner per job',
	kind: 'identity',
	surface: 'label',
	verify: 'mint',
	description:
		'This node mints a runner per job. Carried ONLY by JIT mints, never by a standing ' +
		'registration, so the canary workflow that requests it can be answered only by the ' +
		'ephemeral dispatcher actually working.',
	// Offered to every ephemeral node by `nodeOffer` — declaring it is
	// redundant. `mintOnly` still keeps it off warm/standing listeners.
	mintOnly: true,
	requires: { facts: [MUST_BE_EPHEMERAL] },
};
export const BACKSTOP_CAPABILITY: Capability = {
	id: BACKSTOP_LABEL,
	label: 'Backstop on hokon',
	kind: 'identity',
	surface: 'label',
	verify: 'role',
	description:
		'An idle instance on the production host, promoted to hadoku-builder only when the ' +
		'claws are all down. WRITTEN BY runner-health, never declared in the manifest — it is ' +
		'here so that a node which does declare it is recognised rather than reported as ' +
		'unverifiable, and so census.ts stops being the only place its meaning is written.',
};
export const CARGO_BEVY_CAPABILITY: Capability = {
	id: 'cargo-bevy',
	label: 'Fast Bevy builds',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'This node compiles a large Bevy workspace FAST ENOUGH to be worth routing there. ' +
		'THE FIRST MEASURED CAPABILITY — `rust` answers whether the node can build at all ' +
		'and every managed node must, so it is a toolchain entry; this answers how fast, ' +
		'which only some nodes clear, so it is a LABEL. The payload is brave-quartet, a ' +
		'12-member Bevy 0.18 workspace: measured cold on all seven nodes 2026-09-14, ' +
		'`cargo build --workspace --locked` on real disk ran 6.9 min on claw-7 and 47.0 min ' +
		'on claw-3 — a 6.8x spread on identical source, which is why a general "heavy" tier ' +
		'cannot express this. DECLARED BY NO NODE, deliberately: it is EARNED from the ' +
		'bootcamp record and routed by `nodeOffer`, so `machines[].labels` stays untouched ' +
		'and the manifest cannot claim a speed the box has not demonstrated. ' +
		'Watched by the label floor like every demanded label: served while a standing ' +
		'runner carries it or an eligible claw that earned it can mint.',
	measure: {
		metric: 'compile throughput',
		unit: ' monomorphisations/s',
		atLeast: 1200,
		why:
			'Derived from the payload, not chosen. The measured proxy figures against the ' +
			'measured full build (2026-09-14, seven nodes, `payload-routing-2026-09-14.md` ' +
			'§6): claw-7 3528/6.9min, claw-4 2281/10.9min, claw-6 1529/17.0min, ' +
			'claw-1 1495/18.7min, claw-2 1521/24.0min, claw-3 923/47.0min, claw-5 734/33.4min. ' +
			'Spearman 0.929 against build rank, Pearson 0.984 against 1/build-seconds. The ' +
			'full `check` is 1.3x the build — measured, not guessed: claw-3 passed steps 1-25 ' +
			'and was killed by the 3600s JIT TTL at 60 min against a 47-min build, and the ' +
			'ratio then predicts the ~61 min that was observed. 1200 admits claw-7/4/6/1/2 ' +
			'and excludes claw-5 (~43 min full check, 72% of the TTL, no margin) and claw-3 ' +
			'(over it). It sits in the WIDE EMPTY BAND 923 -> 1495, so the one proxy ' +
			'inversion that exists (claw-1 vs claw-2, 2% apart) cannot flip anybody across ' +
			'it. And it is not just "the big boxes": claw-6 has 4 cores and 8 GB and earns ' +
			'it, claw-5 has 8 cores and 16 GB and does not — the existing 16 GB heavy rule ' +
			'selects claw-3/4/5 and would have routed a CPU-bound compile to two of the ' +
			'three WORST nodes for it. Re-tune here and nowhere else; the probe prints the ' +
			'number and never compares it.',
	},
};
export const JDK21_CAPABILITY: Capability = {
	/*
	 * jdk21 (cardtable#5, added 2026-10-05): forge-e2e/forge-jvm move off
	 * the production host onto whichever claws can hold the JVM's
	 * footprint (p50 2.9 GB, p95 5.5 GB, max 10 GB). EARNED, like
	 * `cargo-bevy` and `av1-nvenc` — never declared, because
	 * `command -v java` lies the same way an encoder listing does:
	 * present-and-broken is indistinguishable from absent without running
	 * it.
	 *
	 * A DIFFERENTIATOR BETWEEN CLAWS, NOT A REQUIREMENT OF THE GENERAL
	 * POOL. Only SOME claws will ever earn it
	 * (`scripts/lib/toolchain-floor.mjs`'s `installedRamAtLeast` gates it on
	 * measured RAM — forge's footprint does not fit every box), and
	 * `requiredIdentitySet` does not add a pinned job's `jdk21` demand to the
	 * set every claw must prove, for the same reason `pm2-host`'s workload is
	 * not a fleet-wide requirement just because one repo pins to it.
	 *
	 * THE LABEL FLOOR WATCHES IT LIKE ANY OTHER DEMANDED LABEL
	 * (`src/label-floor.ts`, 2026-10-10). It was `floor: false` until then,
	 * because the floor counted standing runners only and every claw is JIT;
	 * now it is served while a standing runner carries it OR a claw that
	 * earned it — tool probe AND a fresh workload proof, through `nodeOffer`'s
	 * gate — can mint, and pages when neither holds.
	 *
	 * PROVEN BY THE SAME EXECUTION `REPAIRS.jdk21`/`REPAIRS.maven` use for
	 * `detect` (`scripts/lib/toolchain-floor.mjs`): compile and run a
	 * one-class program with the installed `javac`/`java`, then run
	 * `mvn -v`, all from a non-login shell on the stock PATH.
	 * `scripts/capability-probe.sh` runs the identical execution and emits
	 * `CAP jdk21`, so `fleet bootcamp` both INSTALLS jdk21/maven on an
	 * assigned, qualifying claw (`ensureTools` reads `applicableRepairs`,
	 * keyed off `tool.when`) and WRITES the result into
	 * `$capabilities.earned` once the probe confirms it — the same two-step
	 * contract every other `verify: 'probe'` label here already has.
	 *
	 * WAVE 4E (#102, 2026-10-08): THE TOOL PROOF ABOVE IS NOT ENOUGH.
	 * claw-3 cleared the RAM floor and the tool probe and then failed five
	 * full cardtable `forge-e2e` jobs — a 2-core/4-thread laptop part
	 * saturated by the two JVMs + server + Chromium one job runs alone.
	 * Neither check above says anything about the WORK the label routes,
	 * so this is the second, WORKLOAD proof: the label's real job, run for
	 * real, within a budget derived from nodes that already pass it. See
	 * {@link JobProofBudget} and `workloadGateStatus`.
	 *
	 * THE CHOSEN SPECS, AND WHY (`inputs.specs`). `play.spec.ts` and
	 * `arrow.spec.ts`, read-only off hadoku-cardtable 2026-10-08:
	 *   - `play.spec.ts`'s one forge-gated test drives a match through
	 *     plain `startPlayStack` — the DIRECT match-start path, no scenario
	 *     seed.
	 *   - `arrow.spec.ts`'s one forge-gated test drives `startPlayStack`
	 *     THEN `startScenarioMatch` — the SCENARIO match-start path, the
	 *     other of the two the harness has.
	 * Together: more than one match (done-when), both match-start paths
	 * covered, and — because EVERY `startPlayStack` call boots the
	 * server's host with the warm spare ready behind the live match's own
	 * JVM (`apps/server/src/play/host.ts`'s "warm spare") — both runs
	 * carry the job's real two-JVM footprint, not a trimmed one. Neither
	 * spec is the single biggest file in the suite; both are the smallest
	 * PAIR that still exercises every path the full 27-spec job does, so
	 * the canary costs minutes, not the ~15-18 min the full job takes.
	 * `only: 'e2e'` skips `forge-jvm` — the workload this label's probe
	 * (`detect`, above) already proves end-to-end on every call.
	 *
	 * THE BUDGET: `factor: 1.5, minProven: 2`. Two already-passing claws
	 * are enough to say "this is the fleet's normal pace for this canary"
	 * without over-fitting to one box's quirks, and 1.5x covers ordinary
	 * contention (wave 4e's own forge.yml note: three concurrent proof
	 * dispatches ran 2x their usual time under load) without admitting a
	 * node that is merely slow rather than saturated.
	 */
	id: 'jdk21',
	label: 'Java 21 + Maven',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'A Temurin 21 JDK and Maven that actually compile and run a program, not merely ' +
		"present on disk. Carried only by claws with room for forge's footprint (cardtable#5) " +
		'— a differentiator between claws, like av1-nvenc, never a requirement of the general ' +
		'pool.',
	jobProof: {
		repo: 'WolffM/hadoku-cardtable',
		workflow: 'forge.yml',
		job: 'forge-e2e',
		ref: 'main',
		inputs: { only: 'e2e', specs: 'play.spec.ts arrow.spec.ts' },
		runsOn: { input: 'runs_on', labels: ['self-hosted', BUILDER_LABEL, 'jdk21'] },
		// cardtable's ci.yml and forge.yml fire on push to main only.
		scratchBranch: true,
		evidence: 'two friends play one Forge match|cast arrow, measured in a real browser|\\d+ passed',
		budget: { factor: 1.5, minProven: 2 },
	},
};
export const DOCKER_CAPABILITY: Capability = {
	/*
	 * docker (2026-10-27, node-users §5.2): a daemon the CI user can BUILD
	 * an image with. brave-quartet's publish-server-image is the one job that
	 * needs it, and it appends this label to the fleet array.
	 *
	 * A LABEL, NOT TOOLCHAIN, since the CI user moved off admin. Before that
	 * every claw's CI was in the `docker` group and docker was a requirement
	 * of the general pool. A cut-over claw's ci user has no group and no
	 * sudo; only the claws given a rootless daemon (`containers: "docker"`,
	 * claw-8 and claw-5) can build, so this differentiates claws now.
	 *
	 * EARNED, never declared: the probe builds FROM scratch with buildx and
	 * reads the layer back, as the ci user, the way the job does.
	 */
	id: 'docker',
	label: 'Docker image builds',
	kind: 'identity',
	surface: 'label',
	verify: 'probe',
	description:
		'The CI user can build a docker image with buildx and read it back: rootless on a ' +
		'cut-over claw, the system daemon through the docker group before that.',
};
