import { defineConfig } from "vite"
import { cloudflare } from "@cloudflare/vite-plugin"
import { fileURLToPath } from "node:url"

// Run the live example against this checkout's package source, without publishing it.
export default defineConfig({
  plugins: [cloudflare()],
  resolve: {
    alias: { "@leostera/clankwerk": fileURLToPath(new URL("../../src/index.ts", import.meta.url)) },
  },
})
