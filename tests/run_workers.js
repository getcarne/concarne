// concarne multi-worker test entry. Run standalone:
//   carne run tests/run_workers.js (from the package root).
// Must NOT be required from tests/run.js: with workers > 1 every
// worker re-runs this whole file, so the driver (fetch/assert/close)
// is gated on process.isWorker. Main + workers all run listen(); only
// main fetches and closes.
const http = require("std/http");
const concarne = require("../index.js");
const check = require("./helper.js").check;

var app = concarne();
app.get("/hi", (req, res) => res.json({hi: "ada", worker: process.isWorker}));
app.get("/users/:id", (req, res) => res.json({id: req.params.id}));

var srv = app.listen(18420, {workers: 2});
if (!process.isWorker) {
  check(srv.workers === 2, "listen reports workers: 2");
}

(async () => {
  if (process.isWorker) return;
  var r = await http.get("http://127.0.0.1:18420/hi");
  check(r.status === 200, "workers GET /hi is 200");
  var hello = JSON.parse(r.body);
  check(hello.hi === "ada", "workers body roundtrips");
  check(typeof hello.worker === "boolean", "workers expose process.isWorker");

  r = await http.get("http://127.0.0.1:18420/users/42");
  check(JSON.parse(r.body).id === "42", "workers :param extracts");

  // Hit it repeatedly: both runtimes answer on the shared port.
  for (var i = 0; i < 20; i++) {
    r = await http.get("http://127.0.0.1:18420/hi");
    check(r.status === 200, "workers sustain repeated hits (" + i + ")");
  }

  check(app.close() === true, "workers close reports true");
  console.log("all concarne worker tests passed");
})();
