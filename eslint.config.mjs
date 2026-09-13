import next from 'eslint-config-next';

/**
 * Next 16 ships a native flat config, so no eslintrc compatibility shim is
 * needed (and the shim in fact breaks on this config's circular plugin refs).
 */
export default [
  ...next,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    ignores: ['.next/**', 'node_modules/**', 'src/db/migrations/**', 'next-env.d.ts'],
  },
];
