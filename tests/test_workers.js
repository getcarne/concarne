// Workers: listen arg parsing + opts passthrough (workers: 1 only).
// Everything here stays single-threaded, so it is safe to run inside
// tests/run.js. Real multi-worker serving lives in run_workers.js,
// which must run as its own process (workers re-run the whole script).
const http = require("std/http");
const concarne = require("../index.js");
const check = require("./helper.js").check;

async function run() {
  // listen(port, opts) with explicit single worker.
  var app = concarne();
  app.get("/hi", (req, res) => res.send("hi ada"));
  var srv = app.listen(18406, {workers: 1});
  check(srv.port === 18406, "listen(port, opts) returns the port");
  check(srv.workers === 1, "listen(port, opts) reports workers");
  var r = await http.get("http://127.0.0.1:18406/hi");
  check(r.status === 200 && r.body === "hi ada", "listen(port, opts) serves");
  check(app.close() === true, "opts close reports true");

  // listen(port, host, opts).
  var app2 = concarne();
  app2.get("/hi", (req, res) => res.send("hi again"));
  var srv2 = app2.listen(18407, "127.0.0.1", {workers: 1});
  check(srv2.host === "127.0.0.1", "listen(port, host, opts) keeps the host");
  r = await http.get("http://127.0.0.1:18407/hi");
  check(r.body === "hi again", "listen(port, host, opts) serves");
  app2.close();

  // listen(port, opts, cb): callback gets {port, host, workers}.
  var app3 = concarne();
  app3.get("/hi", (req, res) => res.send("cb"));
  var seen = null;
  var srv3 = app3.listen(18408, {workers: 1}, function (info) { seen = info; });
  check(seen !== null && seen.port === 18408 && seen.workers === 1,
    "listen(port, opts, cb) calls back with info");
  check(srv3.port === 18408, "listen(port, opts, cb) still returns info");
  r = await http.get("http://127.0.0.1:18408/hi");
  check(r.body === "cb", "listen(port, opts, cb) serves");
  app3.close();

  // listen(port, cb) still works (backwards compat).
  var app4 = concarne();
  app4.get("/hi", (req, res) => res.send("compat"));
  var seen4 = null;
  app4.listen(18409, function (info) { seen4 = info; });
  check(seen4 !== null && seen4.port === 18409 && seen4.workers === 1,
    "listen(port, cb) still works, workers defaults to 1");
  r = await http.get("http://127.0.0.1:18409/hi");
  check(r.body === "compat", "listen(port, cb) serves");
  app4.close();

  // Bad workers values surface http.serve's range error.
  var threw = 0;
  try {
    concarne().listen(18410, {workers: 0});
  } catch (e) { threw++; }
  try {
    concarne().listen(18410, {workers: 65});
  } catch (e) { threw++; }
  check(threw === 2, "invalid workers values throw");

  // Duplicate/garbage args are concarne errors, not serve errors.
  var argThrew = 0;
  try {
    concarne().listen(18410, "127.0.0.1", "127.0.0.1");
  } catch (e) { argThrew++; }
  try {
    concarne().listen(18410, {workers: 1}, {workers: 1});
  } catch (e) { argThrew++; }
  try {
    concarne().listen(18410, 42);
  } catch (e) { argThrew++; }
  check(argThrew === 3, "duplicate/bad listen args throw");
}

module.exports = {run: run};
