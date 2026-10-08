import { DurableObject } from "cloudflare:workers"
import { Files } from "@cloudflare/sandbox"
import { coderWorkspaceSource, type CoderWorkspaceEnv } from "./coder-workspace-config.js"
export { coderWorkspaceSource } from "./coder-workspace-config.js"
export type { CoderWorkspaceEnv } from "./coder-workspace-config.js"

const root = "/workspace/repo"
const maxOutput = 32_000
const text = new TextDecoder()

/** A separate Linux container for each Coder instance. No GitHub/API credentials enter it. */
export class CoderWorkspace extends DurableObject<CoderWorkspaceEnv> {
  private source() {
    return coderWorkspaceSource(this.env)
  }
  private async container(): Promise<Container> {
    const container = this.ctx.container
    if (!container) throw new Error("Coder container is not attached")
    if (!container.running) {
      const snapshot = await this.ctx.storage.get<ContainerSnapshot>("workspace-snapshot")
      if (snapshot)
        container.start({ containerSnapshot: { id: snapshot.id }, instance: "standard-1", enableInternet: true })
      else {
        const image = container.images.sandbox
        if (!image) throw new Error("Coder image is unavailable")
        container.start({ image, instance: "standard-1", enableInternet: true })
      }
      await container.setInactivityTimeout(60 * 60_000)
    }
    for (let attempt = 0; !container.running && attempt < 60; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (!container.running) throw new Error("Coder container did not become ready in 60s")
    return container
  }

  private async checkpoint(container: Container): Promise<void> {
    const snapshot = await container.snapshotContainer()
    await this.ctx.storage.put("workspace-snapshot", snapshot)
  }

  async checkout(repo: string): Promise<{ repo: string; status: string }> {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..")
      throw new Error("Expected a repository name")
    const owner = this.source().owner
    const container = await this.container()
    const expected = `https://github.com/${owner}/${repo}.git`
    const existing = await container.exec(["git", "-C", root, "remote", "get-url", "origin"])
    const remote = await existing.output()
    if (remote.exitCode === 0) {
      if (text.decode(remote.stdout).trim() !== expected)
        throw new Error("This instance belongs to a different repository")
      return { repo: `${owner}/${repo}`, status: "already checked out" }
    }
    const clone = await container.exec(["git", "clone", "--depth", "1", expected, root], { cwd: "/workspace" })
    const output = await clone.output()
    if (output.exitCode !== 0) throw new Error(`Public clone failed: ${text.decode(output.stderr).slice(0, 800)}`)
    await this.checkpoint(container)
    return { repo: `${owner}/${repo}`, status: "checked out" }
  }

  /** Full read-only Git clone. The gateway is a Worker RPC capability, not an OAuth token. */
  async clonePrivate(repo: string, gateway: Fetcher): Promise<{ repo: string; status: string; head: string }> {
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..")
      throw new Error("Expected a repository name")
    const owner = this.source().owner
    const container = await this.container()
    if ((await (await container.exec(["test", "-e", root])).output()).exitCode === 0)
      throw new Error("Workspace already exists; choose a fresh Coder instance")
    // Intercept only github.com TLS; the Worker gateway allows upload-pack, not receive-pack.
    await container.interceptOutboundHttps("github.com:443", gateway)
    const trust = await (
      await container.exec([
        "sh",
        "-c",
        "cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/clankwerk-ca.crt && update-ca-certificates",
      ])
    ).output()
    if (trust.exitCode !== 0) throw new Error("Could not trust the container's ephemeral outbound CA")
    const clone = await container.exec(
      ["git", "-c", "protocol.version=1", "clone", `https://github.com/${owner}/${repo}.git`, root],
      { cwd: "/workspace" },
    )
    const result = await clone.output()
    if (result.exitCode !== 0)
      throw new Error(`Read-only Git clone failed: ${text.decode(result.stderr).slice(0, 500)}`)
    const head = await (await container.exec(["git", "-C", root, "rev-parse", "HEAD"])).output()
    if (head.exitCode !== 0) throw new Error("Cannot inspect cloned Git HEAD")
    await this.checkpoint(container)
    return { repo: `${owner}/${repo}`, status: "full read-only Git clone", head: text.decode(head.stdout).trim() }
  }

  /** Refresh the configured base branch while preserving uncommitted work. */
  async syncBase(
    gateway: Fetcher,
    previousBase: string,
    expectedBase: string,
  ): Promise<{ base: string; changed: boolean; conflicts: boolean }> {
    return this.syncMain(gateway, previousBase, expectedBase)
  }

  /** Compatibility name; the configured base branch need not be named main. */
  async syncMain(
    gateway: Fetcher,
    previousMain: string,
    expectedMain: string,
  ): Promise<{ base: string; changed: boolean; conflicts: boolean }> {
    const source = this.source()
    if (!/^[a-f0-9]{40}$/.test(expectedMain) || !/^[a-f0-9]{40}$/.test(previousMain))
      throw new Error("Invalid base commit")
    const container = await this.container()
    const command = async (argv: string[]) => {
      const result = await (await container.exec(argv, { cwd: root })).output()
      return {
        exitCode: result.exitCode,
        stdout: text.decode(result.stdout).slice(0, 2_000),
        stderr: text.decode(result.stderr).slice(0, 500),
      }
    }
    const remote = await command(["git", "remote", "get-url", "origin"])
    if (remote.exitCode || remote.stdout.trim() !== source.url) throw new Error("Cannot sync an unrelated workspace")
    const before = await command(["git", "rev-parse", "HEAD"])
    if (before.exitCode || ![previousMain, expectedMain].includes(before.stdout.trim()))
      throw new Error("Workspace HEAD has changed outside the workflow")
    await container.interceptOutboundHttps("github.com:443", gateway)
    const fetched = await command(["git", "-c", "protocol.version=1", "fetch", "--no-tags", "origin", source.base])
    if (fetched.exitCode) throw new Error("Read-only base fetch failed")
    const main = await command(["git", "rev-parse", `refs/remotes/origin/${source.base}`])
    if (main.exitCode || main.stdout.trim() !== expectedMain)
      throw new Error("Base moved while refreshing the checkout")
    const conflicts = async () => {
      const result = await command(["git", "diff", "--name-only", "--diff-filter=U"])
      if (result.exitCode) throw new Error("Cannot inspect conflict state")
      return Boolean(result.stdout.trim())
    }
    const pending = await this.ctx.storage.get<{ target: string; stashed: boolean }>("base-sync")
    if (pending && pending.target !== expectedMain) throw new Error("A different base sync is unfinished")
    const status = await command(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"])
    if (status.exitCode) throw new Error("Cannot inspect the checkout")
    if (before.stdout.trim() === expectedMain && !pending)
      return { base: expectedMain, changed: false, conflicts: await conflicts() }
    if (before.stdout.trim() === previousMain && !pending) {
      if (await conflicts()) throw new Error("Resolve prior conflicts before another base sync")
      await this.ctx.storage.put("base-sync", { target: expectedMain, stashed: false })
    }
    const state = await this.ctx.storage.get<{ target: string; stashed: boolean }>("base-sync")
    if (!state || state.target !== expectedMain) throw new Error("Base sync state is unavailable")
    if (before.stdout.trim() === previousMain) {
      let stashExists = state.stashed
      if (!stashExists) {
        if (status.stdout) {
          const stashed = await command([
            "git",
            "stash",
            "push",
            "--include-untracked",
            "-m",
            `clankwerk-sync-${expectedMain}`,
          ])
          if (stashed.exitCode || !stashed.stdout.includes("Saved working directory"))
            throw new Error("Could not preserve the working tree")
          await this.checkpoint(container)
          stashExists = true
        } else {
          const marker = await command(["git", "stash", "list", "-1", "--format=%gs"])
          if (marker.exitCode) throw new Error("Cannot inspect the saved work")
          stashExists = marker.stdout.includes(`clankwerk-sync-${expectedMain}`)
        }
      }
      await this.ctx.storage.put("base-sync", { target: expectedMain, stashed: stashExists })
      const reset = await command(["git", "reset", "--hard", expectedMain])
      if (reset.exitCode) throw new Error("Cannot advance the local checkout")
      await this.checkpoint(container)
    }
    const saved = await this.ctx.storage.get<{ target: string; stashed: boolean }>("base-sync")
    if (!saved || saved.target !== expectedMain) throw new Error("Saved sync state changed")
    let hasConflicts = await conflicts()
    if (saved.stashed && !hasConflicts) {
      const work = await command(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"])
      if (work.exitCode) throw new Error("Cannot inspect restored work")
      if (!work.stdout) {
        const applied = await command(["git", "stash", "apply", "stash@{0}"])
        hasConflicts = await conflicts()
        await this.checkpoint(container)
        if (applied.exitCode && !hasConflicts) throw new Error("Cannot reapply the saved work")
      }
    }
    await this.ctx.storage.delete("base-sync")
    return { base: expectedMain, changed: true, conflicts: hasConflicts }
  }

  /** Credential-free source snapshot. This is NOT a Git clone with upstream history or push access. */
  async checkoutSnapshot(snapshot: {
    repo: string
    branch: string
    sha: string
    archive: ArrayBuffer
  }): Promise<{ repo: string; status: string; sourceCommit: string; branch: string }> {
    if (
      typeof snapshot.repo !== "string" ||
      !snapshot.repo.startsWith(`${this.source().owner}/`) ||
      !/^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9._-]{1,100}$/.test(snapshot.repo) ||
      !/^[0-9a-f]{40}$/.test(snapshot.sha) ||
      !/^[a-zA-Z0-9._/-]{1,100}$/.test(snapshot.branch) ||
      !snapshot.archive ||
      snapshot.archive.byteLength > 12 * 1024 * 1024
    )
      throw new Error("Invalid private snapshot")
    const container = await this.container()
    const check = await (await container.exec(["test", "-e", root])).output()
    if (check.exitCode === 0) throw new Error("Workspace already exists; choose a fresh Coder instance")
    const archive = "/workspace/.clankwerk-checkout.tar.gz"
    const command = async (argv: string[]) => {
      const result = await (await container.exec(argv)).output()
      if (result.exitCode !== 0) throw new Error(`Workspace setup failed: ${argv[0]}`)
    }
    await new Files(container).writeFile(archive, snapshot.archive)
    try {
      await command(["mkdir", "-p", root])
      await command(["tar", "-xzf", archive, "--strip-components=1", "-C", root])
      await command(["git", "-C", root, "init", "-b", snapshot.branch])
      await command(["git", "-C", root, "remote", "add", "origin", `https://github.com/${snapshot.repo}.git`])
      await command(["git", "-C", root, "add", "-A"])
      await command([
        "git",
        "-C",
        root,
        "-c",
        "user.name=Clankwerk Snapshot",
        "-c",
        "user.email=snapshot@clankwerk.invalid",
        "commit",
        "--allow-empty",
        "-m",
        `Read-only snapshot of ${snapshot.sha}`,
      ])
      await this.checkpoint(container)
      return {
        repo: snapshot.repo,
        status: "read-only snapshot checked out (not a Git clone)",
        sourceCommit: snapshot.sha,
        branch: snapshot.branch,
      }
    } finally {
      await (await container.exec(["rm", "-f", archive])).output()
    }
  }

  async run(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (
      !Array.isArray(argv) ||
      argv.length < 1 ||
      argv.length > 20 ||
      argv.some((arg) => typeof arg !== "string" || arg.length > 1_000)
    )
      throw new Error("Expected an argv array (1–20 short strings)")
    const container = await this.container()
    const process = await container.exec(argv, { cwd: root })
    const timeout = setTimeout(() => process.kill(), 30_000)
    try {
      // Cap output on the Worker side: the agent cannot force unbounded log buffering.
      const read = async (stream: ReadableStream | null) => {
        if (!stream) return ""
        const reader = stream.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
          if (size + bytes.byteLength > maxOutput) {
            process.kill()
            await reader.cancel()
            break
          }
          chunks.push(bytes)
          size += bytes.byteLength
        }
        return chunks.map((chunk) => text.decode(chunk, { stream: false })).join("")
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        read(process.stdout),
        read(process.stderr),
        process.exitCode,
      ])
      if (exitCode === 0) await this.checkpoint(container)
      return { exitCode, stdout, stderr }
    } finally {
      clearTimeout(timeout)
    }
  }

  async draft(): Promise<{
    issue: number
    title: string
    base: string
    files: { path: string; content: string | null }[]
    patch: string
    digest: string
  } | null> {
    return (await this.ctx.storage.get("issue-draft")) ?? null
  }

  /** Freeze a small text-only diff for a trusted Worker to publish via GitHub's API. */
  async prepareDraft(
    issue: number,
    title: string,
  ): Promise<{
    issue: number
    title: string
    base: string
    files: { path: string; content: string | null }[]
    patch: string
    digest: string
  }> {
    if (
      !Number.isSafeInteger(issue) ||
      issue < 1 ||
      typeof title !== "string" ||
      title.length > 200 ||
      !title.trim() ||
      /[\x00-\x1f]/.test(title)
    )
      throw new Error("Invalid issue")
    const source = this.source()
    const remote = await this.run(["git", "remote", "get-url", "origin"])
    if (remote.exitCode !== 0 || remote.stdout.trim() !== source.url)
      throw new Error("Workspace does not belong to the configured repository")
    const base = await this.run(["git", "rev-parse", `refs/remotes/origin/${source.base}`])
    const head = await this.run(["git", "rev-parse", "HEAD"])
    if (
      base.exitCode ||
      head.exitCode ||
      !/^[a-f0-9]{40}$/.test(base.stdout.trim()) ||
      head.stdout.trim() !== base.stdout.trim()
    )
      throw new Error("Workspace HEAD moved from the reviewed base")
    const status = await this.run(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"])
    if (status.exitCode !== 0) throw new Error("Cannot inspect Coder changes")
    const changes = status.stdout.split("\0").filter(Boolean)
    if (!changes.length || changes.length > 12) throw new Error("Expected 1–12 changed files")
    const paths: { path: string; deleted: boolean }[] = []
    for (const item of changes) {
      const flags = item.slice(0, 2)
      const path = item.slice(3)
      if (
        !/^(\?\?|[ MAD]{2})$/.test(flags) ||
        item[2] !== " " ||
        !path ||
        path.length > 200 ||
        path.startsWith("/") ||
        path.split("/").some((part) => !part || part === "." || part === "..") ||
        /[\x00-\x1f\\]/.test(path) ||
        /(^|\/)\.git(?:\/|$)/.test(path) ||
        /(^|\/)\.env(?:\.|$)/.test(path) ||
        path.startsWith(".github/workflows/")
      )
        throw new Error("Unsupported or protected file change")
      paths.push({ path, deleted: flags.includes("D") })
    }
    const container = await this.container()
    const files = new Files(container)
    const content: { path: string; content: string | null }[] = []
    let total = 0
    for (const { path, deleted } of paths) {
      if (deleted) {
        content.push({ path, content: null })
        continue
      }
      const file = safePath(path)
      const details = await files.lstat(file)
      if (details.type !== "file" || details.size > 100_000n)
        throw new Error("Only small regular text files can be published")
      const response = await files.readFile(file)
      if (!response.ok || !response.body) throw new Error("Could not read changed file")
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 100_000) {
          await reader.cancel()
          throw new Error("Changed file exceeds limit")
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const part of chunks) {
        bytes.set(part, offset)
        offset += part.length
      }
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      total += length
      if (total > 100_000) throw new Error("Draft exceeds 100KB")
      content.push({ path, content: value })
    }
    for (const { path } of paths) {
      const staged = await this.run(["git", "add", "-A", "--", path])
      if (staged.exitCode !== 0) throw new Error("Could not stage reviewed file")
    }
    const diff = await this.run(["git", "diff", "--cached", "--no-ext-diff", "HEAD"])
    if (diff.exitCode !== 0 || !diff.stdout.trim()) throw new Error("Empty or oversized draft diff")
    const draft = { issue, title, base: base.stdout.trim(), files: content, patch: diff.stdout }
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(draft))))
    const digest = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")
    const artifact = { ...draft, digest }
    await this.ctx.storage.put("issue-draft", artifact)
    return artifact
  }

  async read(path: string): Promise<string> {
    const container = await this.container()
    const file = await new Files(container).readFile(safePath(path))
    if (!file.ok) throw new Error(`Read failed: ${file.status}`)
    const contents = await file.text()
    if (contents.length > maxOutput) throw new Error("File exceeds read limit")
    return contents
  }

  async write(path: string, content: string): Promise<void> {
    if (content.length > 100_000) throw new Error("File exceeds write limit")
    const container = await this.container()
    const destination = safePath(path)
    await new Files(container).mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true })
    await new Files(container).writeFile(destination, content)
    await this.checkpoint(container)
  }
}

function safePath(path: string): string {
  if (
    !path ||
    path.length > 255 ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Expected a relative path within the checkout")
  return `${root}/${path}`
}
