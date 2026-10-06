import { Think } from "@cloudflare/think"
import { Clankwerk } from "@leostera/clankwerk"

export class Researcher extends Think<Cloudflare.Env> {
  getModel() {
    return "@cf/meta/llama-4-scout-17b-16e-instruct" as const
  }

  getSystemPrompt() {
    return "You are a helpful research assistant."
  }
}

export const definition = Clankwerk.defineAgent({ id: "researcher", agent: Researcher })
