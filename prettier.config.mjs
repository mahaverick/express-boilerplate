// prettier.config.mjs
export default {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'es5',
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  importOrder: ['<BUILTIN_MODULES>', '<THIRD_PARTY_MODULES>', '^@/(.*)$', '^[./]'],
}
