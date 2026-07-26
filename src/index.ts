#!/usr/bin/env node

const help = `preprocess

The Process authoring CLI foundation is installed.

Commands will be introduced from executable platform contracts.
`

export function run(args: readonly string[]): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(help)
    return 0
  }

  process.stderr.write(`Unknown command: ${args.join(" ")}\n`)
  return 2
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2))
}

