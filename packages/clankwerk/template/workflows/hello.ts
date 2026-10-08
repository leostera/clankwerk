import { Clankwerk, Id, Task } from "@leostera/clankwerk"
import { Effect } from "effect"
import { helloTrigger } from "../triggers/manual.ts"

const greet = Task.fn({
  id: Id.node("greet"),
  run: (name: string) => Effect.succeed(`Hello, ${name}!`),
})

export default Clankwerk.defineWorkflow({ id: "hello", graph: helloTrigger.then(greet) })
