// Router: params, wildcards, methods, middleware order and scoping.
const http = require("std/http");
const concarne = require("../index.js");
const check = require("./helper.js").check;

async function run() {
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
  check(JSON.parse(r.body).id === "42", ":param extracts");

  r = await http.get("http://127.0.0.1:18402/users/a%20b");
  check(JSON.parse(r.body).id === "a b", ":param decodes");

  r = await http.get("http://127.0.0.1:18402/files/a/b/c.txt");
  check(JSON.parse(r.body).rest === "a/b/c.txt", "wildcard spans slashes");

  r = await http.get("http://127.0.0.1:18402/multi");
  check(r.body === "chained", "array + chained handlers run in order");

  r = await http.post("http://127.0.0.1:18402/users", "x");
  check(r.status === 201 && r.body === "made", "method routing (POST)");

  r = await http.get("http://127.0.0.1:18402/users");
  check(r.status === 404, "wrong method does not match (404, no 405 in v1)");

  r = await http.fetch("http://127.0.0.1:18402/any", {method: "PUT"});
  check(r.body === "PUT", "all() matches every method");

  order = [];
  r = await http.get("http://127.0.0.1:18402/api/seen");
  check(JSON.stringify(JSON.parse(r.body).order) === '["global","api-scope"]', "prefix use() runs for its subtree");

  order = [];
  r = await http.get("http://127.0.0.1:18402/plain");
  check(JSON.stringify(JSON.parse(r.body).order) === '["global"]', "prefix use() skips other paths");

  app.close();
}

module.exports = {run: run};
