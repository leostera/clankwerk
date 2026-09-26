import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(import.meta.dir, "..")
const distribution = resolve(root, "dist")
const packages = ["core", "artifacts", "agent", "scheduler", "cloudflare", "ui"]

rmSync(distribution, { recursive: true, force: true })
mkdirSync(distribution, { recursive: true })

for (const name of packages) {
  const source = resolve(root, "packages", name, "dist")
  const destination = resolve(distribution, name)
  if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Missing build output for @libclank/${name}; run the workspace build first`)
  }
  copyRuntimeFiles(source, destination)
}

rewriteWorkspaceImports(distribution)
buildCli()

function copyRuntimeFiles(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.endsWith(".map") || /\.(test|spec)\./.test(entry.name)) continue
    const from = resolve(source, entry.name)
    const to = resolve(destination, entry.name)
    if (entry.isDirectory()) copyRuntimeFiles(from, to)
    else if (entry.isFile()) copyFileSync(from, to)
  }
}

function rewriteWorkspaceImports(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      rewriteWorkspaceImports(path)
      continue
    }
    if (!entry.isFile() || !(entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) continue

    const original = readFileSync(path, "utf8")
    let content = original
    content = content.replace(/\n?\/\/# sourceMappingURL=.*(?:\r?\n)?/g, "")
    content = content.replace(
      /(["'])@libclank\/(core|artifacts|agent|scheduler|cloudflare|ui)(\/[^"']*)?\1/g,
      (_match, quote: string, packageName: string, subpath: string | undefined) => {
        const target = resolve(distribution, packageName, subpath?.slice(1) || "index.js")
        let specifier = relative(dirname(path), target)
        if (!specifier.startsWith(".")) specifier = `./${specifier}`
        return `${quote}${specifier}${quote}`
      },
    )
    if (/["']@libclank\/(?:core|artifacts|agent|scheduler|cloudflare|ui)(?:\/[^"']*)?["']/.test(content)) {
      throw new Error(`Unrewritten workspace import in ${path}`)
    }
    if (content !== original) writeFileSync(path, content)
  }
}

function buildCli(): void {
  const output = resolve(distribution, "bin", "libclank.js")
  mkdirSync(dirname(output), { recursive: true })
  const result = spawnSync(
    "bun",
    ["build", resolve(root, "bin/libclank.ts"), "--target=bun", "--sourcemap=none", `--outfile=${output}`],
    { cwd: root, stdio: "inherit" },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  chmodSync(output, 0o755)
}
