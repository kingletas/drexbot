import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{
		ignores: ['node_modules/**', '**/dist/**', '**/results/**', '**/baselines/**', '**/ledger/**'],
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
