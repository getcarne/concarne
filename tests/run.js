// concarne test entry: runs every case file sequentially in one run.
// Usage: carne run tests/run.js (from the package root).
const terminal = require("std/terminal");
const basics = require("./test_basics.js");
const router = require("./test_router.js");
const bodies = require("./test_bodies.js");
const errors = require("./test_errors.js");
const cors = require("./test_cors.js");
const ratelimit = require("./test_ratelimit.js");
const statics = require("./test_static.js");
const workers = require("./test_workers.js");

(async () => {
  await basics.run();
  await router.run();
  await bodies.run();
  await errors.run();
  await cors.run();
  await ratelimit.run();
  await statics.run();
  await workers.run();
  console.log(terminal.green("all concarne tests passed"));
})();
