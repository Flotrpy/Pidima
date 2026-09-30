import { registerRuntime } from "./registry";
import { githubRuntime } from "./github/runtime";
import { slackRuntime } from "./slack/runtime";

let done = false;
/** Registers every provider runtime once. Imported by the server code that needs provider I/O. */
export function initConnectors() {
  if (done) return;
  done = true;
  registerRuntime(githubRuntime);
  registerRuntime(slackRuntime);
}
