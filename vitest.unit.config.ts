import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.ts'

/**
 * Everything the base config runs except tests/integration/**, with no
 * globalSetup: the base globalSetup creates and migrates the per-worker
 * Postgres databases, so without this override even unit-only runs fail
 * when the Docker stack is down. The git hooks use this config.
 */
const config = mergeConfig(
  base,
  defineConfig({
    test: { exclude: [...configDefaults.exclude, 'tests/integration/**'] },
  })
)
// Assigned after the merge: mergeConfig concatenates arrays, so passing
// `globalSetup: []` to it would keep the base entry.
config.test = { ...config.test, globalSetup: [] }

export default config
