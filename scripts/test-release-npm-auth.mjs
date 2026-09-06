import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { extractWorkflowStepScript } from './lib/extractWorkflowStepScript.mjs';

const execFileAsync = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const workflowText = readFileSync(
	path.join(repositoryRoot, '.github/workflows/release.yml'),
	'utf8',
);

// Executes the literal script release.yml ships, not a hand-copied duplicate.
const script = extractWorkflowStepScript(
	workflowText,
	'release',
	'Authenticate to npm through OIDC trusted publishing',
);

// A stand-in for both endpoints the step talks to: GitHub's OIDC token service and the
// npm registry's package-scoped exchange. Fully offline and deterministic.
const requests = [];
let exchangeStatus = 200;
let exchangeBody = { token: 'npm_fake_publish_token' };

const server = createServer((request, response) => {
	requests.push({
		method: request.method,
		url: request.url,
		authorization: request.headers.authorization,
	});

	if (request.url.startsWith('/oidc')) {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ value: 'fake-github-id-token' }));
		return;
	}

	response.writeHead(exchangeStatus, { 'content-type': 'application/json' });
	response.end(JSON.stringify(exchangeBody));
});

await new Promise(resolve => {
	server.listen(0, '127.0.0.1', resolve);
});

const { port } = server.address();
const registry = `http://127.0.0.1:${port}/`;

// The child must run asynchronously: a synchronous spawn would block this process's event
// loop, leaving the server above unable to answer the request the child makes.
async function run({ packageName = '@mikode13/example', env = {}, existingNpmrc } = {}) {
	const directory = mkdtempSync(path.join(tmpdir(), 'release-npm-auth-'));
	writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageName }));
	if (existingNpmrc !== undefined) {
		writeFileSync(path.join(directory, '.npmrc'), existingNpmrc);
	}

	const scriptPath = path.join(directory, 'authenticate.cjs');
	writeFileSync(scriptPath, script);

	const childEnv = {
		PATH: process.env.PATH,
		NPM_REGISTRY: registry,
		ACTIONS_ID_TOKEN_REQUEST_URL: `${registry}oidc?api-version=2.0`,
		ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-runner-request-token',
		...env,
	};
	for (const [key, value] of Object.entries(childEnv)) {
		if (value === undefined) {
			delete childEnv[key];
		}
	}

	try {
		const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
			cwd: directory,
			env: childEnv,
		});
		return { ok: true, stdout, stderr: '', directory };
	} catch (error) {
		return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '', directory };
	}
}

try {
	// A successful exchange writes a credential npm will actually read, and masks it.
	{
		requests.length = 0;
		const result = await run();

		assert.ok(result.ok, `expected success, got:\n${result.stderr}`);

		const npmrc = readFileSync(path.join(result.directory, '.npmrc'), 'utf8');
		assert.match(
			npmrc,
			new RegExp(`^//127\\.0\\.0\\.1:${port}/:_authToken=npm_fake_publish_token$`, 'm'),
			`expected an auth token line for the registry authority; got:\n${npmrc}`,
		);

		assert.match(
			result.stdout,
			/::add-mask::npm_fake_publish_token/,
			'the exchanged token must be masked before any later log line',
		);

		const [idTokenRequest, exchangeRequest] = requests;
		assert.match(
			idTokenRequest.url,
			/audience=npm%3Aregistry\.npmjs\.org/,
			'the OIDC token must be requested for the npm audience',
		);
		assert.equal(idTokenRequest.authorization, 'Bearer fake-runner-request-token');

		assert.equal(exchangeRequest.method, 'POST');
		assert.equal(
			exchangeRequest.url,
			'/-/npm/v1/oidc/token/exchange/package/%40mikode13%2Fexample',
			'the scoped package name must be URL encoded in the exchange path',
		);
		assert.equal(
			exchangeRequest.authorization,
			'Bearer fake-github-id-token',
			'the exchange must present the GitHub OIDC token, not the runner request token',
		);
	}

	// A consumer's own .npmrc must survive, since the step appends rather than overwrites.
	{
		requests.length = 0;
		const result = await run({ existingNpmrc: 'registry=https://registry.npmjs.org/\n' });

		assert.ok(result.ok, `expected success, got:\n${result.stderr}`);

		const npmrc = readFileSync(path.join(result.directory, '.npmrc'), 'utf8');
		assert.match(npmrc, /^registry=https:\/\/registry\.npmjs\.org\/$/m);
		assert.match(npmrc, /_authToken=npm_fake_publish_token/);
	}

	// Without OIDC context the step must fail loudly, naming the missing permission,
	// rather than falling through to an ENEEDAUTH after the tag has already been pushed.
	{
		requests.length = 0;
		const result = await run({
			env: {
				ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
			},
		});

		assert.equal(result.ok, false, 'expected a failure without OIDC context');
		assert.match(result.stderr, /id-token: write/);
		assert.equal(requests.length, 0, 'no network call should be attempted without OIDC context');
	}

	// A rejected exchange must name the likely cause, which is the Trusted Publisher entry.
	{
		requests.length = 0;
		exchangeStatus = 403;
		exchangeBody = { message: 'no trusted publisher configured' };

		const result = await run();

		assert.equal(result.ok, false, 'expected a failure when npm rejects the exchange');
		assert.match(result.stderr, /npm rejected the OIDC token exchange/);
		assert.match(result.stderr, /403/);
		assert.match(result.stderr, /Trusted Publisher/);

		exchangeStatus = 200;
		exchangeBody = { token: 'npm_fake_publish_token' };
	}
} finally {
	// Always close, so a failed assertion reports instead of hanging on an open handle.
	server.close();
}

process.stdout.write(
	'Release npm OIDC authentication behaves correctly for every tested scenario.\n',
);
