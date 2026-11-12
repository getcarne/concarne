// Workers: listen arg parsing + opts passthrough (workers: 1 only).
// Everything here stays single-threaded. Real multi-worker serving
// lives in run_workers.js, which must run as its own process
// (workers re-run the whole script).
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

test("workers: listen arg parsing and single-worker serving", async () => {
  // listen(port, opts) with explicit single worker.
  var app = concarne();
  app.get("/hi", (req, res) => res.send("hi ada"));
  var srv = app.listen(18406, {workers: 1});
  expect(srv.port).toBe(18406);
  expect(srv.workers).toBe(1);
  var r = await http.get("http://127.0.0.1:18406/hi");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hi ada");
  expect(app.close()).toBe(true);

  // listen(port, host, opts).
  var app2 = concarne();
  app2.get("/hi", (req, res) => res.send("hi again"));
  var srv2 = app2.listen(18407, "127.0.0.1", {workers: 1});
  expect(srv2.host).toBe("127.0.0.1");
  r = await http.get("http://127.0.0.1:18407/hi");
  expect(r.body).toBe("hi again");
  app2.close();

  // listen(port, opts, cb): callback gets {port, host, workers}.
  var app3 = concarne();
  app3.get("/hi", (req, res) => res.send("cb"));
  var seen = null;
  var srv3 = app3.listen(18408, {workers: 1}, function (info) { seen = info; });
  expect(seen !== null).toBe(true);
  expect(seen.port).toBe(18408);
  expect(seen.workers).toBe(1);
  expect(srv3.port).toBe(18408);
  r = await http.get("http://127.0.0.1:18408/hi");
  expect(r.body).toBe("cb");
  app3.close();

  // listen(port, cb) still works (backwards compat).
  var app4 = concarne();
  app4.get("/hi", (req, res) => res.send("compat"));
  var seen4 = null;
  app4.listen(18409, function (info) { seen4 = info; });
  expect(seen4 !== null).toBe(true);
  expect(seen4.port).toBe(18409);
  expect(seen4.workers).toBe(1);
  r = await http.get("http://127.0.0.1:18409/hi");
  expect(r.body).toBe("compat");
  app4.close();

  // Bad workers values surface http.serve's range error.
  var threw = 0;
  try {
    concarne().listen(18410, {workers: 0});
  } catch (e) { threw++; }
  try {
    concarne().listen(18410, {workers: 65});
  } catch (e) { threw++; }
  expect(threw).toBe(2);

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
  expect(argThrew).toBe(3);
});
