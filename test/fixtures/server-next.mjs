// server-next.mjs — the next protocol's server, for the tests of a client
// that is one protocol newer than this code: it serves the home DECIDE_HOME
// names, speaks PROTOCOL + 1, and is the `engine` such a client starts.
// It serves only when run as `server-next.mjs serve`: `node --test` also
// runs every file under test/, and then it does nothing.

import { startServer } from "../../lib/server.mjs";
import { PROTOCOL } from "../../lib/protocol.mjs";

if (process.argv[2] !== "serve") process.exit(0);
// Never the real ~/.decide: a test always names the home.
if (!process.env.DECIDE_HOME) {
  console.error("server-next: DECIDE_HOME is required");
  process.exit(2);
}
const started = await startServer({ home: process.env.DECIDE_HOME, protocol: PROTOCOL + 1 });
if (!started) {
  console.log("decide: a server of this decide home is already running");
  process.exit(0);
}
console.log(`DECIDE serving: http://127.0.0.1:${started.port}/`);
