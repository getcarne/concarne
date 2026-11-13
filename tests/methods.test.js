// Methods: HEAD-from-GET, explicit HEAD/OPTIONS, 405 + Allow,
// auto-OPTIONS, route() chaining.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

test("methods: HEAD, 405 + Allow, OPTIONS, route chaining", async () => {
  var app = concarne();
  app.get("/item/:id", (req, res) => res.json({id: req.params.id}));
  app.post("/item/:id", (req, res) => res.send("posted"));
  app.route("/chained")
    .get((req, res) => res.send("g"))
    .post((req, res) => res.status(201).send("p"));
  app.head("/ping", (req, res) => res.set("X-Ping", "yes").end(""));
  app.options("/custom", (req, res) => res.send("opts"));
  app.get("/stall", (req, res, next) => {});
  app.listen(18450);

  // HEAD to a GET route: 200, same headers, empty body.
  var r = await http.fetch("http://127.0.0.1:18450/item/7", {method: "HEAD"});
  expect(r.status).toBe(200);
  expect(r.body).toBe("");
  expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");

  // GET still answers normally.
  r = await http.get("http://127.0.0.1:18450/item/7");
  expect(JSON.parse(r.body).id).toBe("7");

  // Wrong method on a known path: 405 + Allow (GET implies HEAD).
  r = await http.fetch("http://127.0.0.1:18450/item/7", {method: "PUT"});
  expect(r.status).toBe(405);
  var allow = r.headers["allow"] || "";
  expect(allow.indexOf("GET") >= 0).toBe(true);
  expect(allow.indexOf("HEAD") >= 0).toBe(true);
  expect(allow.indexOf("POST") >= 0).toBe(true);
  expect(JSON.parse(r.body).error).toBe("Method Not Allowed");

  // Unknown path stays 404.
  r = await http.get("http://127.0.0.1:18450/nope");
  expect(r.status).toBe(404);

  // OPTIONS to a known path auto-answers with Allow.
  r = await http.fetch("http://127.0.0.1:18450/item/7", {method: "OPTIONS"});
  expect(r.status).toBe(200);
  expect((r.headers["allow"] || "").indexOf("GET") >= 0).toBe(true);

  // An explicit OPTIONS route wins over the auto-answer.
  r = await http.fetch("http://127.0.0.1:18450/custom", {method: "OPTIONS"});
  expect(r.body).toBe("opts");

  // An explicit HEAD route runs its handler.
  r = await http.fetch("http://127.0.0.1:18450/ping", {method: "HEAD"});
  expect(r.status).toBe(200);
  expect(r.headers["x-ping"]).toBe("yes");

  // route() chaining registers every verb on the one path.
  r = await http.get("http://127.0.0.1:18450/chained");
  expect(r.body).toBe("g");
  r = await http.post("http://127.0.0.1:18450/chained", "");
  expect(r.status).toBe(201);
  expect(r.body).toBe("p");

  // A handler that neither sends nor calls next() is a 500, not a hang.
  r = await http.get("http://127.0.0.1:18450/stall");
  expect(r.status).toBe(500);

  app.close();
});
