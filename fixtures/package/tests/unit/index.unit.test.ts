import { describe, expect, it } from 'vitest';

import { greet } from '../../src/index.js';

describe('greet', () => {
	it('greets the supplied name', () => {
		expect(greet('MiKode')).toBe('Hello, MiKode.');
	});
});
