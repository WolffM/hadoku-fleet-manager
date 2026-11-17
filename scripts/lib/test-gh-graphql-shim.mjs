/**
 * The bash `case` arm a reconcile test's `gh` shim uses to answer
 * `readWorkflowBodies`' GraphQL read (./workflow-bodies.mjs,
 * fleet-manager#111). Every alias the query names (`r0: repository`, ...)
 * gets the same workflow directory.
 *
 * `body` is a bash word that expands to the workflow text, already safe
 * inside a JSON string (no `"` or `\` other than `\n`). `files: false`
 * answers an empty directory. `LISTING_404=1` in the environment answers a
 * repo with no `.github/workflows`; `pre` is bash run first (a failure hook).
 */
const DEFAULT_BODY = "'jobs:\\n  check:\\n    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}\\n'";

export function graphqlWorkflowsArm({ body = DEFAULT_BODY, files = true, pre = '' } = {}) {
	const entries = files
		? '[{\\"name\\":\\"ci.yml\\",\\"type\\":\\"blob\\",\\"object\\":{\\"text\\":\\"$wf_body\\"}}]'
		: '[]';
	return [
		'  *"api graphql"*)',
		pre ? `    ${pre}` : '',
		`    wf_body=${body}`,
		'    printf \'{"data":{\'',
		"    sep=''",
		"    for a in $(printf '%s' \"$*\" | grep -o 'r[0-9]*: repository' | cut -d: -f1); do",
		'      if [ -n "${LISTING_404:-}" ]; then obj=null',
		`      else obj="{\\"entries\\":${entries}}"; fi`,
		`      printf '%s"%s":{"object":%s}' "$sep" "$a" "$obj"; sep=','`,
		'    done',
		"    printf '}}\\n' ;;",
	]
		.filter(Boolean)
		.join('\n');
}
