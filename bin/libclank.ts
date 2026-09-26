#!/usr/bin/env bun
import { basename, resolve } from "node:path"
import { createProject } from "../cli/new.js"
import { version } from "../package.json"

const [command, ...args] = process.argv.slice(2)

if (command === "--help" || command === "-h" || command === undefined || args.includes("--help")) {
  printHelp()
  process.exit(0)
}

if (command !== "new") {
  console.error(`Unknown command: ${command}`)
  printHelp()
  process.exit(1)
}

try {
  let directory = "."
  let name: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === "--name") {
      name = args[index + 1]
      if (!name || name.startsWith("--")) throw new Error("--name requires a project name")
      index += 1
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`)
    } else {
      directory = argument
    }
  }

  const target = resolve(directory)
  name ??= basename(target)
  const result = createProject({ directory: target, name, version })
  console.log(`Initialized LibClank project in ${target}`)
  for (const path of result.created) console.log(`  + ${path}`)
  for (const path of result.skipped) console.log(`  - kept ${path}`)
  console.log("\nNext steps:")
  console.log(`  cd ${target}`)
  console.log("  bun install")
  console.log("  bun run dev")
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

function printHelp(): void {
  console.log(`LibClank ${version}

Usage:
  libclank new [directory] [--name <project-name>]

Scaffolds a Bun + Cloudflare Worker project with agents, tasks, triggers,
and workflows. Existing files are kept; only missing starter files are added.`)
}
