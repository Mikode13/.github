import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	extractWorkflowStepScript,
	readWorkflow,
} from '../support/fixtures/workflowStep.fixture.ts';

const execFileAsync = promisify(execFile);

interface RecordedRequest {
	method: string | undefined;
	url: string | undefined;
	authorization: string | undefined;
}

interface RunOptions {
	packageName?: string;
	env?: Record<string, string | undefined>;
	existingNpmrc?: string;
}

interface RunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	directory: string;
}

// The literal script release.yml ships, not a hand-copied duplicate.
const script = extractWorkflowStepScript(
	readWorkflow('release.yml'),
	'release',
	'Authenticate to npm through OIDC trusted publishing',
);

const requests: RecordedRequest[] = [];
let exchangeStatus = 200;
let exchangeBody: unknown = { token: 'npm_fake_publish_token' };

// A stand-in for both endpoints the step talks to: GitHub's OIDC token service and the
// npm registry's package-scoped exchange. Fully offline and deterministic.
const server: Server = createServer((request, response) => {
	requests.push({
		method: request.method,
		url: request.url,
		authorization: request.headers.authorization,
	});

	if (request.url?.startsWith('/oidc')) {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ value: 'fake-github-id-token' }));
		return;
	}

	response.writeHead(exchangeStatus, { 'content-type': 'application/json' });
	response.end(JSON.stringify(exchangeBody));
});

let registry: string;
let port: number;

beforeAll(async () => {
	await new Promise<void>(resolve => {
		server.listen(0, '127.0.0.1', resolve);
	});

	port = (server.address() as AddressInfo).port;
	registry = `http://127.0.0.1:${String(port)}/`;
});

// Always close, so a failed assertion reports instead of hanging on an open handle.
afterAll(async () => {
	await new Promise<void>(resolve => {
		server.close(() => {
			resolve();
		});
	});
});

/**
 * The child must run asynchronously: a synchronous spawn would block this process's event
 * loop, leaving the server above unable to answer the request the child makes.
 */
async function run({
	packageName = '@mikode13/example',
	env = {},
	existingNpmrc,
}: RunOptions = {}): Promise<RunResult> {
	const directory = mkdtempSync(path.join(tmpdir(), 'release-npm-auth-'));
	writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: packageName }));

	if (existingNpmrc !== undefined) {
		writeFileSync(path.join(directory, '.npmrc'), existingNpmrc);
	}

	const scriptPath = path.join(directory, 'authenticate.cjs');
	writeFileSync(scriptPath, script);

	// An explicitly undefined override removes the variable rather than passing it through
	// as the string "undefined", which is how the missing-OIDC-context case is expressed.
	const childEnv = Object.fromEntries(
		Object.entries({
			PATH: process.env.PATH,
			NPM_REGISTRY: registry,
			ACTIONS_ID_TOKEN_REQUEST_URL: `${registry}oidc?api-version=2.0`,
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-runner-request-token',
			...env,
		}).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);

	try {
		const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
			cwd: directory,
			env: childEnv,
		});
		return { ok: true, stdout, stderr: '', directory };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string };
		return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', directory };
	}
}

describe('npm OIDC trusted publishing authentication', () => {
	it('writes a credential npm will read, and masks it', async () => {
		requests.length = 0;
		const result = await run();

		expect(result.ok, result.stderr).toBe(true);

		const npmrc = readFileSync(path.join(result.directory, '.npmrc'), 'utf8');
		expect(npmrc).toMatch(
			new RegExp(`^//127\\.0\\.0\\.1:${String(port)}/:_authToken=npm_fake_publish_token$`, 'm'),
		);
		expect(result.stdout).toMatch(/::add-mask::npm_fake_publish_token/);
	});

	it('requests the GitHub token for the npm audience and exchanges it for the package', async () => {
		requests.length = 0;
		await run();

		const [idTokenRequest, exchangeRequest] = requests;

		expect(idTokenRequest?.url).toMatch(/audience=npm%3Aregistry\.npmjs\.org/);
		expect(idTokenRequest?.authorization).toBe('Bearer fake-runner-request-token');

		expect(exchangeRequest?.method).toBe('POST');
		expect(exchangeRequest?.url).toBe(
			'/-/npm/v1/oidc/token/exchange/package/%40mikode13%2Fexample',
		);
		// The GitHub OIDC token, not the runner request token.
		expect(exchangeRequest?.authorization).toBe('Bearer fake-github-id-token');
	});

	it("preserves a consumer's existing .npmrc, because the step appends", async () => {
		requests.length = 0;
		const result = await run({ existingNpmrc: 'registry=https://registry.npmjs.org/\n' });

		expect(result.ok, result.stderr).toBe(true);

		const npmrc = readFileSync(path.join(result.directory, '.npmrc'), 'utf8');
		expect(npmrc).toMatch(/^registry=https:\/\/registry\.npmjs\.org\/$/m);
		expect(npmrc).toMatch(/_authToken=npm_fake_publish_token/);
	});

	// Failing loudly here matters: the alternative is an ENEEDAUTH after the release tag
	// has already been pushed.
	it('fails naming the missing permission when there is no OIDC context', async () => {
		requests.length = 0;
		const result = await run({
			env: {
				ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined,
			},
		});

		expect(result.ok).toBe(false);
		expect(result.stderr).toMatch(/id-token: write/);
		expect(requests).toHaveLength(0);
	});

	it('names the Trusted Publisher entry when npm rejects the exchange', async () => {
		requests.length = 0;
		exchangeStatus = 403;
		exchangeBody = { message: 'no trusted publisher configured' };

		try {
			const result = await run();

			expect(result.ok).toBe(false);
			expect(result.stderr).toMatch(/npm rejected the OIDC token exchange/);
			expect(result.stderr).toMatch(/403/);
			expect(result.stderr).toMatch(/Trusted Publisher/);
		} finally {
			exchangeStatus = 200;
			exchangeBody = { token: 'npm_fake_publish_token' };
		}
	});
});
