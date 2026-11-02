/**
 * The pure naming/parsing half of `prove-job.ts` (wave 5o lane D split, pure
 * move): proof-runner names, the `runs-on` workflow reader, and resolving a
 * capability's `jobProof` into a `ProveSpec`. No GitHub call, no clock, no
 * node — see `prove-job.ts` for the orchestration this feeds.
 */
import { capability, type JobProof } from '../lib/capability-registry.js';

import { type ProveSpec } from './prove-job-types.js';
import { jitRunnerName } from '../lib/jit-naming.js';

/** `owner/repo` -> `repo`, narrowed to what a unit name admits. */
function repoSlug(repo: string): string {
	return repo
		.split('/')
		.pop()!
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, '-');
}

/**
 * The proof runner's name. `proof-` inside the slug is what `isProofRunnerName`
 * keys on; `j0-r0` is a run id no real run has (see the header).
 */
export function proofRunnerName(node: string, repo: string, nowMs: number): string {
	return jitRunnerName(node, `x/proof-${repoSlug(repo)}`, nowMs, 0, 0);
}

/** Is this a proof runner minted for `node`? Stricter than a prefix: a real mint never ends `-j0-r0-`. */
/** A label unique to one proof, so an aimed canary can land nowhere else. */
export function proofLabel(nowMs: number): string {
	return `proof-${nowMs.toString(36)}`;
}

/** The throwaway branch a scratch-branch canary is dispatched on. */
export function scratchBranchName(node: string, nowMs: number): string {
	return `canary/${node}-${nowMs.toString(36)}`;
}

/**
 * The `workflow_dispatch` body. `inputs` only when there is one — a workflow
 * with no `inputs:` declared must see the body it has always seen — and the
 * runs-on input, when the spec names one, carries the proof runner's labels.
 */
export function dispatchBody(
	spec: Pick<ProveSpec, 'ref' | 'inputs' | 'runsOnInput'>,
	labels: readonly string[]
): { ref: string; inputs?: Record<string, string> } {
	const inputs: Record<string, string> = { ...(spec.inputs ?? {}) };
	if (spec.runsOnInput) inputs[spec.runsOnInput] = JSON.stringify(labels);
	return Object.keys(inputs).length ? { ref: spec.ref, inputs } : { ref: spec.ref };
}

/** Drop a trailing `# comment` that is not inside quotes. Workflow `runs-on` lines are simple. */
function stripComment(line: string): string {
	let q: string | null = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) {
			if (c === q) q = null;
		} else if (c === '"' || c === "'") q = c;
		else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
	}
	return line;
}

const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');

export type RunsOn = { ok: true; labels: string[]; jobKey: string } | { ok: false; reason: string };

/**
 * The `runs-on` labels of ONE job, read from the workflow text.
 *
 * Deliberately not a YAML parser: this package has no dependencies, and a
 * workflow's `runs-on` is a scalar, a flow list or a block list. Anything else —
 * an expression (`${{ fromJSON(vars.CI_RUNNER) }}`), a `group:` map — is REFUSED
 * with a reason, because guessing the label set would mint a runner the job
 * cannot land on and report it as a lost race. The caller's `--labels-override`
 * is the explicit way out.
 */
export function runsOnForJob(yaml: string, jobName: string): RunsOn {
	const lines = yaml.split('\n').map(stripComment);
	const jobsAt = lines.findIndex((l) => /^jobs\s*:\s*$/.test(l));
	if (jobsAt === -1) return { ok: false, reason: 'the workflow has no top-level `jobs:`' };
	const indentOf = (l: string): number => l.length - l.trimStart().length;
	const blank = (l: string): boolean => l.trim() === '';
	let keyIndent = -1;
	const blocks: { key: string; body: string[] }[] = [];
	for (let i = jobsAt + 1; i < lines.length; i++) {
		const l = lines[i];
		if (blank(l)) continue;
		if (indentOf(l) === 0) break;
		if (keyIndent === -1) keyIndent = indentOf(l);
		if (indentOf(l) === keyIndent) {
			const m = /^\s*([\w.-]+)\s*:/.exec(l);
			if (m) blocks.push({ key: m[1], body: [] });
			continue;
		}
		blocks[blocks.length - 1]?.body.push(l);
	}
	const hit = blocks.find((b) => {
		const nm = b.body.find((l) => indentOf(l) === keyIndent + 2 && /^\s*name\s*:/.test(l));
		return (
			b.key === jobName || (nm !== undefined && unquote(nm.replace(/^\s*name\s*:/, '')) === jobName)
		);
	});
	if (!hit) {
		return {
			ok: false,
			reason: `no job named "${jobName}" in the workflow (jobs: ${blocks.map((b) => b.key).join(', ') || 'none'})`,
		};
	}
	const at = hit.body.findIndex((l) => indentOf(l) === keyIndent + 2 && /^\s*runs-on\s*:/.test(l));
	if (at === -1) return { ok: false, reason: `job "${jobName}" has no \`runs-on\`` };
	const inline = hit.body[at].replace(/^\s*runs-on\s*:/, '').trim();
	let raw: string[];
	if (inline.startsWith('[')) {
		const end = inline.indexOf(']');
		if (end === -1)
			return { ok: false, reason: '`runs-on` is a flow list this reader cannot parse' };
		raw = inline.slice(1, end).split(',');
	} else if (inline) raw = [inline];
	else {
		raw = [];
		for (let i = at + 1; i < hit.body.length; i++) {
			const l = hit.body[i];
			if (blank(l)) continue;
			if (indentOf(l) <= keyIndent + 2) break;
			const m = /^\s*-\s*(.+)$/.exec(l);
			if (!m)
				return {
					ok: false,
					reason: '`runs-on` is a map (group/labels) this reader does not resolve',
				};
			raw.push(m[1]);
		}
	}
	const labels = raw.map(unquote).filter(Boolean);
	if (!labels.length) return { ok: false, reason: '`runs-on` is empty' };
	const dynamic = labels.find((x) => x.includes('${{'));
	if (dynamic) {
		return {
			ok: false,
			reason: `\`runs-on\` is an expression (${dynamic}) that only GitHub can resolve — pass the labels with --labels-override`,
		};
	}
	return { ok: true, labels: [...new Set(labels)], jobKey: hit.key };
}

/** Does the workflow accept `workflow_dispatch`? Read from the `on:` section only. */
export function isDispatchable(yaml: string): boolean {
	const head = yaml.split('\n').map(stripComment);
	const jobsAt = head.findIndex((l) => /^jobs\s*:/.test(l));
	const on = (jobsAt === -1 ? head : head.slice(0, jobsAt)).join('\n');
	return /(^|[\s[,])workflow_dispatch\s*(:|,|\]|$)/m.test(on);
}

/**
 * The log lines that show the capability was EXERCISED.
 *
 * Timestamps are stripped so the evidence reads as the job printed it, and lines
 * are de-duplicated and truncated so a chatty job cannot bloat the JSON past the
 * 8 KB pipe cliff (`keepStdoutWhole` copes, but a consumer reading a file should
 * not have to).
 */
export function extractEvidence(log: string, pattern: string, max = 40): string[] {
	const re = new RegExp(pattern, 'i');
	const seen = new Set<string>();
	for (const raw of log.split(/\r?\n/)) {
		const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').trim();
		if (line && re.test(line)) seen.add(line.length > 300 ? `${line.slice(0, 300)}…` : line);
		if (seen.size >= max) break;
	}
	return [...seen];
}

/** Resolve the job a capability declares, with an explicit operator override winning per field. */
export function specFromCapability(
	capabilityId: string,
	over: Partial<ProveSpec> & { node: string }
): { ok: true; spec: ProveSpec } | { ok: false; reason: string } {
	const cap = capability(capabilityId);
	if (!cap) return { ok: false, reason: `"${capabilityId}" is not a registered capability` };
	const p: JobProof | undefined = cap.jobProof;
	if (!p) {
		return {
			ok: false,
			reason: `capability "${capabilityId}" declares no jobProof — name the job with --repo/--workflow/--job`,
		};
	}
	return {
		ok: true,
		spec: {
			repo: over.repo ?? p.repo,
			workflow: over.workflow ?? p.workflow,
			job: over.job ?? p.job,
			ref: over.ref ?? p.ref ?? 'main',
			evidence: over.evidence ?? p.evidence,
			inputs: over.inputs ?? p.inputs,
			...(p.runsOn ? { labelsOverride: p.runsOn.labels, runsOnInput: p.runsOn.input } : {}),
			...(p.scratchBranch ? { scratchBranch: true } : {}),
			...over,
			capability: capabilityId,
		},
	};
}
