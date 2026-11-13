// Middleware pack: logger, helmet, requestId in core.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

test("middleware: helmet defaults, overrides, app-set wins", async () => {
  var app = concarne();
  app.use(concarne.helmet());
  app.get("/h", (req, res) => res.send("ok"));
  app.get("/own", (req, res) =>
    res.set("X-Frame-Options", "DENY").send("ok"));
  app.listen(18457);

  var r = await http.get("http://127.0.0.1:18457/h");
  expect(r.headers["x-content-type-options"]).toBe("nosniff");
  expect(r.headers["x-frame-options"]).toBe("SAMEORIGIN");
  expect(r.headers["x-dns-prefetch-control"]).toBe("off");
  expect(r.headers["referrer-policy"]).toBe("no-referrer");
  expect(r.headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(r.headers["origin-agent-cluster"]).toBe("?1");

  r = await http.get("http://127.0.0.1:18457/own");
  expect(r.headers["x-frame-options"]).toBe("DENY");

  expect(function () { concarne.helmet({frameOptions: 42}); }).toThrow();
  app.close();

  var custom = concarne();
  custom.use(concarne.helmet({frameOptions: "DENY", referrerPolicy: false}));
  custom.get("/h", (req, res) => res.send("ok"));
  custom.listen(18458);
  r = await http.get("http://127.0.0.1:18458/h");
  expect(r.headers["x-frame-options"]).toBe("DENY");
  expect(r.headers["referrer-policy"]).toBe(undefined);
  custom.close();
});

test("middleware: requestId mints, trusts, echoes", async () => {
  var app = concarne();
  app.use(concarne.requestId());
  app.get("/id", (req, res) => res.json({id: req.id}));
  app.listen(18459);

  var r = await http.get("http://127.0.0.1:18459/id");
  var first = JSON.parse(r.body).id;
  expect(typeof first).toBe("string");
  expect(first.length > 0).toBe(true);
  expect(r.headers["x-request-id"]).toBe(first);

  // Every request mints a fresh id...
  r = await http.get("http://127.0.0.1:18459/id");
  expect(JSON.parse(r.body).id === first).toBe(false);

  // ...unless the client sent one.
  r = await http.get("http://127.0.0.1:18459/id",
    {headers: {"X-Request-Id": "trace-1"}});
  expect(JSON.parse(r.body).id).toBe("trace-1");
  expect(r.headers["x-request-id"]).toBe("trace-1");

  expect(function () { concarne.requestId({header: ""}); }).toThrow();
  expect(function () { concarne.requestId({generate: "x"}); }).toThrow();
  app.close();

  var gen = concarne();
  gen.use(concarne.requestId({generate: () => "fixed"}));
  gen.get("/id", (req, res) => res.send(req.id));
  gen.listen(18460);
  r = await http.get("http://127.0.0.1:18460/id");
  expect(r.body).toBe("fixed");
  expect(r.headers["x-request-id"]).toBe("fixed");
  gen.close();
});

test("middleware: logger passes through and formats", async () => {
  var app = concarne();
  app.use(concarne.logger("tiny"));
  app.get("/l", (req, res) => res.send("logged"));
  app.listen(18461);

  var lines = [];
  var orig = console.log;
  console.log = function (s) { lines.push(String(s)); };
  var r;
  try {
    r = await http.get("http://127.0.0.1:18461/l");
  } finally {
    console.log = orig;
  }
  expect(r.status).toBe(200);
  expect(r.body).toBe("logged");
  expect(lines.length).toBe(1);
  expect(lines[0].indexOf("GET /l 200") === 0).toBe(true);

  expect(function () { concarne.logger("verbose"); }).toThrow();
  app.close();
});
