import { registerRuntime } from "./registry";
import { githubRuntime } from "./github/runtime";

let done = false;
/** Registers every provider runtime once. Imported by the server code that needs provider I/O. */
export function initConnectors() {
  if (done) return;
  done = true;
  registerRuntime(githubRuntime);
}
