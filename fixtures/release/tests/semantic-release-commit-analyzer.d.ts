declare module '@semantic-release/commit-analyzer' {
	interface AnalyzeCommitsConfig {
		preset?: string;
		releaseRules?: unknown[];
	}

	interface AnalyzeCommitsContext {
		commits: { hash: string; message: string }[];
		logger: {
			log: (...args: unknown[]) => void;
			error: (...args: unknown[]) => void;
		};
		cwd: string;
		env: Record<string, string>;
	}

	export function analyzeCommits(
		pluginConfig: AnalyzeCommitsConfig,
		context: AnalyzeCommitsContext,
	): Promise<string | null>;
}
