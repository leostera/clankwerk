import { Id, Triggers } from "@leostera/clankwerk"

export const helloTrigger = Triggers.manual<string>({ id: Id.trigger("hello-api") })
