import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{
		// .claude/ holds worktrees, each a checkout of its own, linted from its own root.
		ignores: [
			'node_modules/**',
			'**/dist/**',
			'**/results/**',
			'**/baselines/**',
			'**/ledger/**',
			'.claude/**',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/consistent-type-imports': 'error',

			// The console reporter owns stdout; nothing else may write to it, because a
			// stray log defeats the silence contract the reporter exists to keep.
			'no-console': 'error',
		},
	},
	{
		files: ['**/src/reporting/**/*.ts', '**/src/cli/**/*.ts', '**/bin/**'],
		rules: { 'no-console': 'off' },
	},
	{
		// The protocol bee runs inside k6, not Node: plain JavaScript with k6's globals and no type information.
		// Its console is k6's log, which the bee sends raw to standard output to write its timeline.
		files: ['bees/**/*.js'],
		...tseslint.configs.disableTypeChecked,
		languageOptions: {
			globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', console: 'readonly' },
		},
		rules: { 'no-console': 'off' },
	},
	{
		// node:test's describe/it return a promise nobody is meant to await, and a
		// test double for an async collaborator often has nothing to await.
		files: ['**/tests/**/*.ts', '**/fixtures/**/*.ts', '**/selfcheck/**/*.ts'],
		rules: {
			'@typescript-eslint/no-floating-promises': 'off',
			'@typescript-eslint/require-await': 'off',
		},
	},
	{
		files: ['**/*.mjs', '**/*.js'],
		...tseslint.configs.disableTypeChecked,
	},
)
