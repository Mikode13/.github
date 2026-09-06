/**
 * Extracts the literal `run: |` body of one `shell: node {0}` step from a workflow YAML
 * file, without a YAML parser dependency (matching validate-ci-status-contract.mjs).
 * This lets a test execute the exact script that ships in the workflow, rather than a
 * hand-copied duplicate that can drift out of sync.
 */
export function extractWorkflowStepScript(workflowText, jobName, stepName) {
	const lines = workflowText.split(/\r?\n/);

	const jobLineIndex = lines.indexOf(`  ${jobName}:`);
	if (jobLineIndex === -1) {
		throw new Error(`Job '${jobName}' not found`);
	}

	const jobEndOffset = lines
		.slice(jobLineIndex + 1)
		.findIndex(line => /^ {2}[a-zA-Z0-9_-]+:/.test(line));
	const jobEnd = jobEndOffset === -1 ? lines.length : jobLineIndex + 1 + jobEndOffset;
	const jobLines = lines.slice(jobLineIndex, jobEnd);

	const stepLineIndex = jobLines.findIndex(line => line.trim() === `- name: ${stepName}`);
	if (stepLineIndex === -1) {
		throw new Error(`Step '${stepName}' not found in job '${jobName}'`);
	}

	const stepIndentMatch = /^(\s*)-/.exec(jobLines[stepLineIndex]);
	const stepIndent = stepIndentMatch[1].length;
	const stepEndOffset = jobLines
		.slice(stepLineIndex + 1)
		.findIndex(line => new RegExp(`^ {${stepIndent}}- `).test(line));
	const stepEnd = stepEndOffset === -1 ? jobLines.length : stepLineIndex + 1 + stepEndOffset;
	const stepLines = jobLines.slice(stepLineIndex, stepEnd);

	const runLineIndex = stepLines.findIndex(line => line.trim() === 'run: |');
	if (runLineIndex === -1) {
		throw new Error(`Step '${stepName}' does not have a 'run: |' block`);
	}

	const runIndentMatch = /^(\s*)run:/.exec(stepLines[runLineIndex]);
	const runIndent = runIndentMatch[1].length;
	const scriptLines = [];

	for (const line of stepLines.slice(runLineIndex + 1)) {
		if (line.trim() === '') {
			scriptLines.push('');
			continue;
		}

		const lineIndentMatch = /^(\s*)/.exec(line);
		const lineIndent = lineIndentMatch[1].length;
		if (lineIndent <= runIndent) {
			break;
		}

		scriptLines.push(line);
	}

	const contentIndents = scriptLines
		.filter(line => line.trim() !== '')
		.map(line => /^(\s*)/.exec(line)[1].length);
	const contentIndent = Math.min(...contentIndents);

	return scriptLines.map(line => line.slice(contentIndent)).join('\n');
}
