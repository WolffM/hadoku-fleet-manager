// identity-stages (fleet-manager#67): every identity-model rule is staged, and
// a staged rule's findings land where its stage says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { blankComments } from './blank-comments.mjs';
import {
	ADVISORY_MAX_DAYS,
	RULE_STAGES,
	familyOf,
	overdueAdvisories,
	splitByStage,
	stageOf,
} from './identity-stages.mjs';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-identity-model.mjs');

/** The check ids the gate can name: its FIXES table, read as source (importing the CLI runs it). */
function gateCheckIds() {
	const src = blankComments(readFileSync(GATE, 'utf8'));
	const block = src.slice(src.indexOf('const FIXES = {'));
	const ids = [...block.matchAll(/^\t(G\d+[a-z]?):/gm)].map((m) => m[1]);
	assert.ok(ids.length >= 9, `read only ${ids.length} check ids from FIXES: the parse is broken`);
	return ids;
}

test('every check the gate can report has a stage, and every stage names a real rule', () => {
	const ids = gateCheckIds();
	for (const id of ids)
		assert.ok(stageOf(id), `${id} has no entry in RULE_STAGES: stage it advisory`);
	const families = new Set(ids.map(familyOf));
	for (const key of Object.keys(RULE_STAGES))
		assert.ok(families.has(familyOf(key)), `RULE_STAGES.${key} names no rule the gate reports`);
});

test('a rule that enforces after staging carries the date it was advisory; an advisory one its start', () => {
	for (const [id, s] of Object.entries(RULE_STAGES)) {
		if (s.stage === 'advisory') assert.ok(Number.isFinite(Date.parse(s.since)), `${id}: since`);
		else if (!s.grandfathered)
			assert.ok(
				Number.isFinite(Date.parse(s.advisorySince ?? '')),
				`${id} enforces with no advisorySince: a new rule ships advisory for one release first`
			);
	}
});

test('advisory findings are reported apart; an UNDECLARED rule is enforced, never softened', () => {
	const stages = { ...RULE_STAGES, G10: { stage: 'advisory', since: '2026-11-06' } };
	const v = (check) => ({ check, file: 'x.ts', line: 1, message: 'm' });
	const { enforced, advisory } = splitByStage([v('G9b'), v('G10'), v('G10a'), v('G99')], stages);
	assert.deepEqual(
		enforced.map((x) => x.check),
		['G9b', 'G99']
	);
	assert.deepEqual(
		advisory.map((x) => x.check),
		['G10', 'G10a']
	);
});

test('an advisory rule past its window is named as overdue, with the fix', () => {
	const stages = { G10: { stage: 'advisory', since: '2026-11-01' } };
	const day = 86_400_000;
	const start = Date.parse('2026-11-01');
	assert.deepEqual(overdueAdvisories(start + ADVISORY_MAX_DAYS * day, stages), []);
	assert.match(
		overdueAdvisories(start + (ADVISORY_MAX_DAYS + 1) * day, stages)[0],
		/G10 .*flip it to enforced/
	);
});
