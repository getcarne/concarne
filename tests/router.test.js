// Router: params, wildcards, methods, middleware order and scoping.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

test("router: params, wildcards, methods, middleware scoping", async () => {
  var app = concarne();
  var order = [];

  app.use((req, res, next) => { order.push("global"); next(); });
  app.use("/api", (req, res, next) => { order.push("api-scope"); next(); });
  app.get("/users/:id", (req, res) => res.json({id: req.params.id}));
  app.get("/files/*", (req, res) => res.json({rest: req.params["0"]}));
  app.get("/multi", [(req, res, next) => next()], (req, res) => res.send("chained"));
  app.post("/users", (req, res) => res.status(201).send("made"));
  app.all("/any", (req, res) => res.send(req.method));
  app.get("/api/seen", (req, res) => res.json({order: order}));
  app.get("/plain", (req, res) => res.json({order: order}));
  app.listen(18402);

  var r = await http.get("http://127.0.0.1:18402/users/42");
  expect(JSON.parse(r.body).id).toBe("42");

  r = await http.get("http://127.0.0.1:18402/users/a%20b");
  expect(JSON.parse(r.body).id).toBe("a b");

  r = await http.get("http://127.0.0.1:18402/files/a/b/c.txt");
  expect(JSON.parse(r.body).rest).toBe("a/b/c.txt");

  r = await http.get("http://127.0.0.1:18402/multi");
  expect(r.body).toBe("chained");

  r = await http.post("http://127.0.0.1:18402/users", "x");
  expect(r.status).toBe(201);
  expect(r.body).toBe("made");

  r = await http.get("http://127.0.0.1:18402/users");
  expect(r.status).toBe(404);

  r = await http.fetch("http://127.0.0.1:18402/any", {method: "PUT"});
  expect(r.body).toBe("PUT");

  order = [];
  r = await http.get("http://127.0.0.1:18402/api/seen");
  expect(JSON.parse(r.body).order).toEqual(["global", "api-scope"]);

  order = [];
  r = await http.get("http://127.0.0.1:18402/plain");
  expect(JSON.parse(r.body).order).toEqual(["global"]);

  app.close();
});
