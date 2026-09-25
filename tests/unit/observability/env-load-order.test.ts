// tests/unit/observability/env-load-order.test.ts
//
// tracing.ts runs via --import, before env.config.ts's dotenv call, so an
// OTEL_* value in .env only reaches it when Node loads .env first. `dev` and
// `start` pass --env-file-if-exists=.env before --import. The image CMD does
// not: the image has no .env and the orchestrator supplies the environment.
// Checked two ways: the committed commands as text, and a spawned process
// running those exact flags with a probe in place of the tracing module and
// an empty entry in place of the app. No build and no network.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const ENV_FLAG = '--env-file-if-exists=.env'
const repoRoot = process.cwd()
const { scripts } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string | undefined>
}

function words(script: string | undefined): string[] {
  if (!script) throw new Error('package.json script is missing')
  return script.trim().split(/\s+/)
}

function dockerCommand(): string[] {
  const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')
  const line = dockerfile.split('\n').find((candidate) => candidate.startsWith('CMD '))
  if (!line) throw new Error('Dockerfile has no CMD line')
  return JSON.parse(line.slice('CMD '.length)) as string[]
}

// Only PATH is passed, so neither this shell's OTEL_SERVICE_NAME nor
// Vitest's own variables reach the child. The timeout fails a hung child
// instead of blocking the worker.
function run(directory: string, commandArguments: string[]): string {
  return execFileSync(process.execPath, commandArguments, {
    cwd: directory,
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })
}

// Swaps the tracing module for the probe and the app entry for an empty file.
function withProbe(argv: string[], tracingModule: string, entry: string): string[] {
  return argv.map((argument) => {
    if (argument === tracingModule) return './probe.mjs'
    if (argument === entry) return './entry.mjs'
    return argument
  })
}

function expectEnvFileBeforeImport(argv: string[]): void {
  const flagAt = argv.indexOf(ENV_FLAG)
  expect(flagAt).toBeGreaterThan(-1)
  expect(argv.indexOf('--import')).toBeGreaterThan(flagAt)
}

describe('launch commands name .env before the tracing --import', () => {
  it('pnpm dev', () => {
    const argv = words(scripts.dev)
    expect(argv.slice(0, 2)).toEqual(['tsx', 'watch'])
    expectEnvFileBeforeImport(argv)
  })

  it('pnpm start', () => {
    expectEnvFileBeforeImport(words(scripts.start))
  })

  // With no .env in the image, the flag would only print a notice to stderr
  // on every boot.
  it('the image CMD does not read .env', () => {
    const argv = dockerCommand()
    expect(argv).toContain('--import')
    expect(argv.some((argument) => argument.startsWith('--env-file'))).toBe(false)
  })
})

describe('those flags, run for real, load .env before the --import module', () => {
  const directories: string[] = []

  // A fresh directory per test: the probe, an empty entry and, optionally, a .env.
  function fixture(dotEnv?: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'env-load-order-'))
    directories.push(directory)
    fs.writeFileSync(
      path.join(directory, 'probe.mjs'),
      "process.stdout.write(process.env.OTEL_SERVICE_NAME ?? 'unset')\n"
    )
    fs.writeFileSync(path.join(directory, 'entry.mjs'), '')
    if (dotEnv !== undefined) fs.writeFileSync(path.join(directory, '.env'), dotEnv)
    return directory
  }

  afterAll(() => {
    for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
  })

  it('pnpm start', () => {
    const [bin, ...rest] = words(scripts.start)
    expect(bin).toBe('node')
    const directory = fixture('OTEL_SERVICE_NAME=from-dot-env\n')
    expect(
      run(directory, withProbe(rest, './dist/observability/tracing.js', 'dist/index.js'))
    ).toBe('from-dot-env')
  })

  // tsx without `watch`: watch strips only its own flags and forwards the
  // rest to the same child launch (tsx dist/cli.mjs, removeArgvFlags).
  it('pnpm dev, through tsx', () => {
    const rest = words(scripts.dev).slice(2)
    const tsxCli = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs')
    const directory = fixture('OTEL_SERVICE_NAME=from-dot-env\n')
    expect(
      run(directory, [tsxCli, ...withProbe(rest, './src/observability/tracing.ts', 'src/index.ts')])
    ).toBe('from-dot-env')
  })

  it('pnpm start with no .env still starts, reading nothing', () => {
    const [, ...rest] = words(scripts.start)
    const directory = fixture()
    expect(
      run(directory, withProbe(rest, './dist/observability/tracing.js', 'dist/index.js'))
    ).toBe('unset')
  })
})
