import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repositoryRoot = new URL('../', import.meta.url);

const contracts = [
	{
		path: '.github/workflows/ci.yml',
		job: 'required',
		expectedName: 'required',
	},
	{
		path: '.github/workflows/validate-workflows.yml',
		job: 'required',
		expectedName: 'CI / required',
	},
	{
		path: 'workflow-templates/ci.yml',
		job: 'ci',
		expectedName: 'CI',
	},
];

const readJobName = (workflow, job) => {
	const lines = workflow.split(/\r?\n/);
	const jobStart = lines.indexOf(`  ${job}:`);

	assert.notEqual(jobStart, -1, `Workflow does not define the '${job}' job`);

	const nextJobOffset = lines
		.slice(jobStart + 1)
		.findIndex(line => /^  [a-zA-Z0-9_-]+:$/.test(line));
	const jobEnd = nextJobOffset === -1 ? lines.length : jobStart + nextJobOffset + 1;
	const nameLine = lines.slice(jobStart + 1, jobEnd).find(line => line.startsWith('    name:'));

	assert.ok(nameLine, `Job '${job}' does not define a name`);

	const name = nameLine.slice('    name:'.length).trim();
	const quote = name.at(0);

	if ((quote === "'" || quote === '"') && name.at(-1) === quote) {
		return name.slice(1, -1);
	}

	return name;
};

for (const contract of contracts) {
	const workflow = await readFile(new URL(contract.path, repositoryRoot), 'utf8');
	const actualName = readJobName(workflow, contract.job);

	assert.equal(
		actualName,
		contract.expectedName,
		`${contract.path} job '${contract.job}' must be named '${contract.expectedName}'`,
	);
}

process.stdout.write('CI status contract is consistent.\n');
