import { strict as assert } from 'node:assert';
import { appendFileSync, mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
	build,
	ftsQuery,
	liveFromPanes,
	liveFromRegistries,
	openIndex,
	procStart,
	projectKey,
	promptOf,
	readTranscript,
	resumable,
	search,
} from './session-index.mjs';
import { tempDir } from './test-tmpdir.mjs';

const user = (content, extra = {}) => ({
	type: 'user',
	message: { role: 'user', content },
	timestamp: new Date(Date.now() - 60_000).toISOString(),
	cwd: '/home/u/repos/app',
	gitBranch: 'main',
	...extra,
});
const line = (r) => `${JSON.stringify(r)}\n`;

test('session-index: only what a human typed is a prompt', () => {
	assert.deepEqual(promptOf(user('fix the runners')), { kind: 'typed', text: 'fix the runners' });
	assert.deepEqual(promptOf(user([{ type: 'text', text: 'with an image' }, { type: 'image' }])), {
		kind: 'typed',
		text: 'with an image',
	});
	const dropped = [
		user('Another Claude session sent a message: ...', { isMeta: true }),
		user('subagent turn', { isSidechain: true }),
		user([{ type: 'tool_result', content: 'output' }]),
		user('<task-notification>\n<task-id>x</task-id>'),
		user('<local-command-stdout>ok</local-command-stdout>'),
		user('<command-name>/model</command-name>'),
		user('<bash-stdout>out</bash-stdout>'),
		user('   '),
		{ type: 'assistant', message: { content: 'typed by the model' } },
	];
	for (const r of dropped) assert.equal(promptOf(r), null, JSON.stringify(r).slice(0, 80));
});

test('session-index: a paste and a ! command are human input, not harness noise', () => {
	assert.deepEqual(promptOf(user('<pasted_content id="1">the digest</pasted_content>')), {
		kind: 'pasted',
		text: 'the digest',
	});
	assert.deepEqual(promptOf(user('<bash-input> cd ~/repos/x</bash-input>')), {
		kind: 'shell',
		text: 'cd ~/repos/x',
	});
});

function store() {
	const projects = tempDir('session-index-');
	const dir = join(projects, '-home-u-repos-app');
	mkdirSync(dir);
	return { projects, dir, db: openIndex(join(tempDir('session-index-db-'), 'i.db')) };
}
const ID = (n) => `0000000${n}-0000-4000-8000-000000000000`;

test('session-index: a transcript is read from where the last read stopped, complete lines only', () => {
	const { dir } = store();
	const f = join(dir, `${ID(1)}.jsonl`);
	writeFileSync(
		f,
		line(user('first prompt')) + line({ type: 'assistant' }) + '{"type":"user","mess'
	);
	const a = readTranscript(f, 0);
	assert.deepEqual(
		a.prompts.map((p) => p.text),
		['first prompt']
	);
	appendFileSync(f, 'age":{"content":"second prompt"}}\n');
	const b = readTranscript(f, a.offset);
	assert.deepEqual(
		b.prompts.map((p) => p.text),
		['second prompt'],
		'the half-written line was left, then read whole'
	);
	assert.equal(readTranscript(f, b.offset).prompts.length, 0);
});

test('session-index: a torn line is counted, not fatal', () => {
	const { dir } = store();
	const f = join(dir, `${ID(1)}.jsonl`);
	writeFileSync(f, `{"type":"user" not json\n${line(user('still here'))}`);
	const r = readTranscript(f, 0);
	assert.equal(r.bad, 1);
	assert.deepEqual(
		r.prompts.map((p) => p.text),
		['still here']
	);
});

test('session-index: build is incremental, resets a rewritten file, and forgets a deleted one', () => {
	const { projects, dir, db } = store();
	const f = join(dir, `${ID(1)}.jsonl`);
	writeFileSync(f, line(user('deploy the pygmalion clone')));
	assert.equal(build(db, projects).added, 1);
	assert.equal(search(db, 'pygmalion').length, 1);
	assert.equal(build(db, projects).read, 0, 'nothing changed, nothing read');

	appendFileSync(f, line(user('now check the tunnel')));
	const grown = build(db, projects);
	assert.deepEqual([grown.read, grown.prompts], [1, 1], 'only the appended prompt');
	assert.equal(search(db, 'tunnel')[0].prompts, 2);

	truncateSync(f, 0);
	writeFileSync(f, line(user('something else entirely')));
	assert.equal(build(db, projects).reset, 1);
	assert.equal(search(db, 'pygmalion').length, 0, 'the rewritten file’s old prompts are gone');

	writeFileSync(
		f,
		line(user('a rewrite that comes back much longer than the file it replaced')).repeat(3)
	);
	assert.equal(build(db, projects).reset, 1, 'a LONGER rewrite is a rewrite too');
	assert.equal(search(db, 'entirely').length, 0);
	assert.equal(search(db, 'rewrite')[0].prompts, 3, 'read from zero, not from the stale offset');

	rmSync(f);
	assert.equal(build(db, projects).removed, 1);
	assert.equal(search(db, '').length, 0);
});

test('session-index: subagent transcripts and non-session files are not indexed', () => {
	const { projects, dir, db } = store();
	mkdirSync(join(dir, ID(1), 'subagents'), { recursive: true });
	writeFileSync(join(dir, ID(1), 'subagents', 'agent-a1.jsonl'), line(user('orchestrated text')));
	writeFileSync(join(dir, 'notes.jsonl'), line(user('orchestrated text')));
	assert.equal(build(db, projects).files, 0);
});

test('session-index: repeated mention outranks a single one, and the title is searchable', () => {
	const { projects, dir, db } = store();
	writeFileSync(
		join(dir, `${ID(1)}.jsonl`),
		line(user('the herdr plugin once')) + line(user('unrelated'))
	);
	writeFileSync(
		join(dir, `${ID(2)}.jsonl`),
		line(user('herdr plugin design')) +
			line(user('herdr plugin tests')) +
			line(user('herdr plugin ship')) +
			line({ type: 'ai-title', aiTitle: 'Old name', sessionId: ID(2) }) +
			line({ type: 'ai-title', aiTitle: 'Fleet panes in herdr', sessionId: ID(2) })
	);
	build(db, projects);
	assert.deepEqual(
		search(db, 'herdr plugin').map((s) => s.id),
		[ID(2), ID(1)]
	);
	const [hit] = search(db, 'panes');
	assert.equal(hit.title, 'Fleet panes in herdr', 'the latest title wins');
	assert.equal(search(db, 'Old name').length, 0, 'a superseded title is not searchable');

	// Claude retitles a live session as it goes, so the usual case is a new
	// title arriving in a LATER build than the one it replaces.
	appendFileSync(
		join(dir, `${ID(2)}.jsonl`),
		line({ type: 'ai-title', aiTitle: 'Renamed later', sessionId: ID(2) })
	);
	build(db, projects);
	assert.equal(search(db, 'Renamed')[0]?.id, ID(2));
	assert.equal(search(db, 'panes').length, 0, 'the title it replaced is gone from the index');
});

test('session-index: whatever is typed into the box is words, never FTS syntax', () => {
	const { projects, dir, db } = store();
	writeFileSync(join(dir, `${ID(1)}.jsonl`), line(user('claw-5 runs slow')));
	build(db, projects);
	for (const q of ['claw-5', '"unbalanced', 'NOT slow', 'slow*', 'a:b', '(claw', "claw's"]) {
		assert.doesNotThrow(() => search(db, q), q);
	}
	assert.equal(search(db, 'claw-5').length, 1);
	assert.equal(search(db, 'cla').length, 1, 'prefix match');
	assert.equal(ftsQuery('  '), '');
});

test('session-index: a registry entry is live only while its pid runs AND started when it says', (t) => {
	const root = tempDir('session-index-reg-');
	const reg = (account) => {
		const d =
			account === 'default'
				? join(root, '.claude', 'sessions')
				: join(root, '.claude-accounts', account, 'sessions');
		mkdirSync(d, { recursive: true });
		return d;
	};
	const me = process.pid;
	const started = procStart(me);
	assert.match(started, /^\d+$/, 'read from the real /proc');
	const a = reg('alice');
	const b = reg('bob');
	const tmux = 'claude:@3.%65';
	writeFileSync(
		join(a, `${me}.json`),
		JSON.stringify({ pid: me, procStart: started, sessionId: ID(1), tmux, status: 'busy' })
	);
	writeFileSync(join(b, '1.json'), JSON.stringify({ pid: me, procStart: '1', sessionId: ID(2) }));
	writeFileSync(
		join(b, '2.json'),
		JSON.stringify({ pid: 2 ** 22 + 7, procStart: '9', sessionId: ID(3) })
	);
	writeFileSync(join(b, '3.json'), '{"pid": 12, "sess');
	const live = liveFromRegistries([reg('default'), a, b]);
	assert.deepEqual([...live.keys()], [ID(1)], 'reused pid, dead pid and a torn file are not live');
	assert.deepEqual(live.get(ID(1)), [
		{ pid: me, account: 'alice', tmux, status: 'busy', name: null },
	]);
	t.diagnostic(`procStart(self) = ${started}`);
});

test('session-index: a claude pane the registry missed is found the way the tmux hook finds it', () => {
	const sid = ID(4);
	const sys = {
		uid: 1000,
		descendants: (pid) => [String(pid), `${pid}1`],
		fdTargets: (pid) => (pid === '101' ? [`/tmp/claude-1000/-home-u-repos-app/${sid}/tasks`] : []),
		cmdline: (pid) => (pid === '201' ? `claude --resume ${ID(5)}` : 'claude'),
	};
	const panes = [
		{ target: 'claude:@1.%1', paneId: '%1', pid: 10, command: 'claude' },
		{ target: 'claude:@2.%2', paneId: '%2', pid: 20, command: 'claude' },
		{ target: 'claude:@3.%3', paneId: '%3', pid: 30, command: 'claude' },
		{ target: 'claude:@4.%4', paneId: '%4', pid: 40, command: 'bash' },
		{ target: 'claude:@5.%5', paneId: '%5', pid: 50, command: 'claude' },
	];
	const { found, unresolved } = liveFromPanes(panes, new Set(['%5']), sys);
	assert.deepEqual([...found.keys()].sort(), [sid, ID(5)].sort());
	assert.deepEqual(
		unresolved,
		['claude:@3.%3'],
		'an unidentifiable claude pane is reported, not dropped'
	);
});

test('session-index: a session keeps its LAUNCH directory when the agent cds elsewhere', () => {
	const { projects, dir, db } = store();
	writeFileSync(
		join(dir, `${ID(1)}.jsonl`),
		line(user('start here', { cwd: '/home/u/repos/app' })) +
			line(user('now over there', { cwd: '/home/u/repos/other' }))
	);
	build(db, projects);
	appendFileSync(join(dir, `${ID(1)}.jsonl`), line(user('and further', { cwd: '/tmp' })));
	build(db, projects);
	const [s] = search(db, '');
	assert.equal(s.cwd, '/home/u/repos/app');
	assert.equal(resumable(s).ok, true);
});

test('session-index: resume only from the directory the transcript is filed under', () => {
	assert.equal(projectKey('/home/u/repos/a_b/.x'), '-home-u-repos-a-b--x');
	assert.deepEqual(resumable({ cwd: '/home/u/repos/app', project: '-home-u-repos-app' }), {
		ok: true,
		why: null,
	});
	assert.match(
		resumable({ cwd: '/home/u/repos/renamed', project: '-home-u-repos-app' }).why,
		/moved or renamed/
	);
	assert.equal(resumable({ cwd: null, project: 'x' }).ok, false);
});
