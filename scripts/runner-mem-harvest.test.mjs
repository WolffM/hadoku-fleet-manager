/**
 * `runner-mem-harvest.py`'s own regressions — #47 (the stems see the all-JIT
 * unit shapes) and #99 (a window closes when its unit's cgroup is GONE, and
 * survives a restart). Split out of `runner-mem.test.mjs` (wave 5q lane D,
 * which crossed the 1,000-line test ceiling) by CONCERN: this half never
 * touches `runner-mem-report.py` at all. The shared fixture helpers
 * (`pyExpr`, `run`, …) live in `scripts/lib/runner-mem-fixtures.mjs`, used by
 * both halves.
 *
 * Nothing here runs real ssh or reads this box's real `/sys`/`/proc` —
 * `pyExpr`/`pyHarvest` drive the module directly against scratch fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HARVEST, run, pyExpr } from './lib/runner-mem-fixtures.mjs';

// ── #47: the stems see the all-JIT unit shapes ───────────────────────────────

test('unit_cgroups matches jit-* and warm-* — the shapes every job has run in since 2026-09-07', () => {
	const root = mkdtempSync(join(tmpdir(), 'mem-cg-'));
	try {
		const mk = (rel) => mkdirSync(join(root, rel), { recursive: true });
		// The five live shapes across the fleet's history, at three depths.
		mk(
			'user.slice/user-1000.slice/user@1000.service/app.slice/jit-claw-1-hadoku-scraper-j101139462953-r33908618175-1788548255.service'
		);
		mk(
			'user.slice/user-1000.slice/user@1000.service/runners.slice/warm-claw-1-hadoku_site.service'
		);
		mk('system.slice/actions.runner.WolffM-hadoku_site.claw-4.service');
		mk('user.slice/user-1000.slice/user@1000.service/app.slice/actions-runner-hadoku_site.service');
		mk('ci.slice/ci-runner.slice/github-runner.service');
		// Decoys: the harvester's OWN unit, a directory without the .service
		// suffix, and a FILE shaped like a unit (rglob must not return it).
		mk('user.slice/user-1000.slice/user@1000.service/app.slice/runner-mem-harvest.service');
		mk('user.slice/user-1000.slice/user@1000.service/app.slice/jit-not-a-unit');
		writeFileSync(
			join(root, 'user.slice/user-1000.slice/user@1000.service/app.slice/warm-file.service'),
			''
		);
		const got = pyExpr(HARVEST, 'sorted(m.unit_cgroups().keys())', {
			HARVEST_CG_ROOT: root,
			HARVEST_INTERVAL: '3',
		});
		assert.deepEqual(got, [
			'actions-runner-hadoku_site.service',
			'actions.runner.WolffM-hadoku_site.claw-4.service',
			'github-runner.service',
			'jit-claw-1-hadoku-scraper-j101139462953-r33908618175-1788548255.service',
			'warm-claw-1-hadoku_site.service',
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── #99: a window closes when its unit's cgroup is GONE, and survives a restart ──

/**
 * Drive the harvester's sweep and recovery against a fake cgroup tree. `body`
 * is Python run with the module loaded as `m`, `CG` pointing at the tree and
 * `RUN` the set of unit names that "have a Runner.Worker" (the real check
 * reads /proc, which a test cannot fake). Whatever it assigns to `out` is
 * returned as JSON.
 */
function pyHarvest(body, { samplesTail = '' } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'mem-step-'));
	const cg = join(root, 'cg');
	mkdirSync(cg);
	const out = join(root, 'samples.jsonl');
	writeFileSync(out, samplesTail);
	const driver = join(root, 'drive.py');
	writeFileSync(
		driver,
		[
			'import importlib.util, json, os, shutil',
			'from pathlib import Path',
			`spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(HARVEST)})`,
			'm = importlib.util.module_from_spec(spec)',
			'spec.loader.exec_module(m)',
			`CG = Path(${JSON.stringify(cg)})`,
			'RUN = set()',
			'm.has_worker = lambda d: d.name in RUN',
			'def mkunit(rel, anon_mb=100, oom=0):',
			'    d = CG / rel',
			'    d.mkdir(parents=True, exist_ok=True)',
			'    (d / "memory.stat").write_text(f"anon {anon_mb * 1048576}\\nshmem 0\\nfile 0\\nslab 0\\n")',
			'    (d / "memory.events").write_text(f"oom_kill {oom}\\n")',
			'    (d / "memory.max").write_text("max\\n")',
			'    (d / "memory.current").write_text(f"{anon_mb * 1048576}\\n")',
			'    return d',
			'out = None',
			body,
			'print(json.dumps(out))',
		].join('\n')
	);
	try {
		const r = run('python3', [driver], {
			env: {
				...process.env,
				HARVEST_CG_ROOT: cg,
				HARVEST_OUT: out,
				HARVEST_INFLIGHT: join(root, 'inflight.json'),
				HARVEST_INTERVAL: '3',
			},
		});
		assert.equal(r.status, 0, `driver failed: ${r.stderr}`);
		return JSON.parse(r.stdout);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const JIT = 'jit-claw-8-hadoku-cardtabl-j114270089448-r38071622195-1791653118.service';

test('a JIT window whose cgroup is gone is closed as vanished, ending at the last sweep that saw the worker', () => {
	const rec = pyHarvest(`
d = mkunit("user.slice/app.slice/${JIT}", anon_mb=700)
RUN.add("${JIT}")
ow = {}
assert m.step(ow, m.unit_cgroups(), 100.0) == []
assert m.step(ow, m.unit_cgroups(), 103.0) == []
shutil.rmtree(d)
done = m.step(ow, m.unit_cgroups(), 106.0)
out = {"done": done, "open": list(ow)}
`);
	assert.deepEqual(rec.open, [], 'the window must not stay open');
	assert.equal(rec.done.length, 1);
	const r = rec.done[0];
	assert.equal(r.closed_by, 'vanished');
	assert.equal(
		r.end,
		103,
		'end is the last sweep that SAW the worker, not the one that found it gone'
	);
	assert.equal(r.vanished_at, 106);
	assert.equal(r.samples, 2);
	assert.equal(r.peak_unreclaimable_mb, 700);
	assert.equal(r.clipped, false, 'a JIT unit ending is how a JIT job ends');
});

test('a unit missing from one scan but whose cgroup still exists is NOT closed — one job, one window', () => {
	const rec = pyHarvest(`
d = mkunit("user.slice/app.slice/${JIT}")
RUN.add("${JIT}")
ow = {}
m.step(ow, m.unit_cgroups(), 100.0)
miss = m.step(ow, {}, 103.0)
m.step(ow, m.unit_cgroups(), 106.0)
RUN.clear()
done = m.step(ow, m.unit_cgroups(), 109.0)
out = {"miss": miss, "done": done}
`);
	assert.deepEqual(rec.miss, [], 'a scan miss is not a vanish');
	assert.equal(rec.done.length, 1);
	assert.equal(rec.done[0].closed_by, 'exit');
	assert.equal(rec.done[0].start, 100);
	assert.equal(rec.done[0].samples, 2);
});

test('a STANDING unit whose cgroup vanishes mid-job is marked torn down, so it never sizes', () => {
	const rec = pyHarvest(`
d = mkunit("ci.slice/ci-runner.slice/actions-runner-hadoku-cardtable.service", anon_mb=4000)
RUN.add("actions-runner-hadoku-cardtable.service")
ow = {}
m.step(ow, m.unit_cgroups(), 100.0)
shutil.rmtree(d)
out = m.step(ow, m.unit_cgroups(), 103.0)
`);
	assert.equal(rec.length, 1);
	assert.equal(rec[0].closed_by, 'vanished');
	assert.equal(rec[0].cgroup_reset, true);
	assert.equal(rec[0].clipped, true);
});

test('the ordinary exit still closes as before, and says so', () => {
	const rec = pyHarvest(`
mkunit("system.slice/warm-claw-4-hadoku_site.service", anon_mb=300)
RUN.add("warm-claw-4-hadoku_site.service")
ow = {}
m.step(ow, m.unit_cgroups(), 100.0)
RUN.clear()
out = m.step(ow, m.unit_cgroups(), 103.0)
`);
	assert.equal(rec.length, 1);
	assert.equal(rec[0].closed_by, 'exit');
	assert.equal(rec[0].end, 103);
	assert.equal(rec[0].peak_anon_mb, 300);
});

test('a restart RESUMES a job still running and WRITES OUT one that finished while it was down', () => {
	const rec = pyHarvest(`
a = mkunit("app.slice/${JIT}", anon_mb=500)
b = mkunit("app.slice/jit-claw-8-hadoku_site-j1-r2-3.service", anon_mb=900)
RUN.update(["${JIT}", "jit-claw-8-hadoku_site-j1-r2-3.service"])
ow = {}
m.step(ow, m.unit_cgroups(), 100.0)
m.step(ow, m.unit_cgroups(), 103.0)
snap = json.loads(json.dumps(m.snapshot(ow, 103.0)))
# the process dies here; b's job ends and its unit goes while nothing watches
shutil.rmtree(b)
RUN.discard("jit-claw-8-hadoku_site-j1-r2-3.service")
ow2, done = m.recover(snap, m.unit_cgroups(), 200.0, set())
m.step(ow2, m.unit_cgroups(), 203.0)
RUN.clear()
fin = m.step(ow2, m.unit_cgroups(), 206.0)
out = {"recovered": done, "resumed": fin}
`);
	assert.equal(rec.recovered.length, 1);
	const r = rec.recovered[0];
	assert.equal(r.unit, 'jit-claw-8-hadoku_site-j1-r2-3.service');
	assert.equal(r.closed_by, 'recovered');
	assert.equal(r.end, 103, 'ends at the last sweep that saw its worker');
	assert.equal(r.peak_anon_mb, 900, 'a new-format snapshot carries the full peak');
	assert.equal(r.dur_approx, undefined);
	assert.equal(rec.resumed.length, 1);
	assert.equal(rec.resumed[0].unit, JIT);
	assert.equal(rec.resumed[0].start, 100, 'the resumed window keeps its original start');
	assert.equal(rec.resumed[0].samples, 3);
});

test('an OLD snapshot (no state) recovers what it knows and omits what it never measured', () => {
	const rec = pyHarvest(`
snap = {"host": m.HOST, "at": 5000.0, "windows": [
  {"unit": "${JIT}", "start": 1000.0, "elapsed_s": 4000.0, "samples": 10,
   "peak_unreclaimable_mb": 812.5, "peak_current_mb": 1500.0, "oom_kills": 0, "cap_mb": 6000.0}]}
ow, done = m.recover(snap, m.unit_cgroups(), 9000.0, set())
out = {"open": list(ow), "done": done}
`);
	assert.deepEqual(rec.open, []);
	const r = rec.done[0];
	assert.equal(r.closed_by, 'recovered');
	assert.equal(r.dur_approx, true);
	assert.equal(r.end, 1030, 'start + samples x INTERVAL, not the snapshot time');
	assert.equal(r.peak_unreclaimable_mb, 812.5);
	assert.equal(r.peak_current_mb, 1500);
	assert.equal('peak_anon_mb' in r, false, 'never measured is omitted, not 0');
	assert.equal(r.clipped, false);
});

test('recovery skips a window already in samples.jsonl, ignores another host, and closes a finished one whose unit lingers', () => {
	const rec = pyHarvest(
		`
mkunit("app.slice/warm-claw-8-hadoku_site.service")
snap = {"host": m.HOST, "at": 50.0, "windows": [
  {"unit": "${JIT}", "start": 10.0, "samples": 3, "peak_unreclaimable_mb": 1.0},
  {"unit": "warm-claw-8-hadoku_site.service", "start": 20.0, "samples": 2, "peak_unreclaimable_mb": 2.0}]}
ow, done = m.recover(snap, m.unit_cgroups(), 60.0, m.recently_written())
other = m.recover(dict(snap, host="somewhere-else"), m.unit_cgroups(), 60.0, set())
out = {"open": list(ow), "units": [r["unit"] for r in done], "by": [r["closed_by"] for r in done], "other": other}
`,
		{ samplesTail: JSON.stringify({ unit: JIT, start: 10.0, end: 19.0 }) + '\n' }
	);
	assert.deepEqual(
		rec.units,
		['warm-claw-8-hadoku_site.service'],
		'the JIT one was already written'
	);
	assert.deepEqual(rec.by, ['recovered']);
	assert.deepEqual(rec.open, [], 'a lingering unit with no worker is not resumed');
	assert.deepEqual(rec.other, [{}, []], "another host's snapshot is ignored whole");
});
