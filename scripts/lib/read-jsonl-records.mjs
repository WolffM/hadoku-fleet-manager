import { existsSync, readFileSync } from 'node:fs';

/**
 * Read a JSONL file into an array of parsed records.
 *
 * `[]` when the file does not exist — neither caller (`collect-job-metrics.mjs`,
 * `join-workload-benchmark.mjs`) treats a missing `job-history.jsonl` as a
 * refusal; both fall through to an empty join. A line that fails to parse
 * costs exactly that one record, by design: the writer can be mid-append to
 * the final line when this reads, and the alternative (failing the whole
 * read) would turn a normal race into an outage.
 * @param {string} file
 * @returns {unknown[]}
 */
export function readJsonlRecords(file) {
	const records = [];
	if (!existsSync(file)) return records;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const t = line.trim();
		if (!t) continue;
		try {
			records.push(JSON.parse(t));
		} catch {
			/* a truncated final line costs one record, by design of the writer */
		}
	}
	return records;
}
