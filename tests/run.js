// concarne test entry: runs every case file sequentially in one run.
// Usage: carne run tests/run.js (from the package root).
var basics = require("./test_basics.js");
var router = require("./test_router.js");
var bodies = require("./test_bodies.js");
var errors = require("./test_errors.js");
var statics = require("./test_static.js");
var workers = require("./test_workers.js");

var statics = require("./test_static.js");

(async () => {
  await basics.run();
  await router.run();
  await bodies.run();
  await errors.run();
  await statics.run();
  await workers.run();
  console.log("all concarne tests passed");
})();
