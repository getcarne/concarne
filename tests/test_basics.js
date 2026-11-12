// Basics: send/json/status/redirect/404/trailing slash.
const http = require("std/http");
const concarne = require("../index.js");
const check = require("./helper.js").check;

async function run() {
  var app = concarne();
  app.get("/hi", (req, res) => res.send("hi ada"));
  app.get("/created", (req, res) => res.status(201).json({made: true}));
  app.get("/old", (req, res) => res.redirect("/hi"));
  app.get("/num", (req, res) => res.send(404));
  var srv = app.listen(18401);
  check(srv.port === 18401, "listen returns the port");

  var r = await http.get("http://127.0.0.1:18401/hi");
  check(r.status === 200, "GET /hi is 200");
  check(r.body === "hi ada", "GET /hi body");
  check(r.headers["content-type"] === "text/html; charset=utf-8", "send defaults to html");

  r = await http.get("http://127.0.0.1:18401/hi/");
  check(r.status === 200 && r.body === "hi ada", "trailing slash matches");

  r = await http.get("http://127.0.0.1:18401/created");
  check(r.status === 201, "custom status survives");
  check(JSON.parse(r.body).made === true, "json body roundtrips");
  check(r.headers["content-type"] === "application/json; charset=utf-8", "json content-type");

  r = await http.get("http://127.0.0.1:18401/old");
  check(r.status === 302, "redirect status");
  check(r.headers["location"] === "/hi", "redirect location");

  r = await http.get("http://127.0.0.1:18401/num");
  check(r.status === 404 && r.body === "Not Found", "send(number) sets status");

  r = await http.get("http://127.0.0.1:18401/nope");
  check(r.status === 404, "unknown path is 404");
  var miss = JSON.parse(r.body);
  check(miss.error === "Not Found" && miss.path === "/nope", "404 default JSON shape");

  check(app.close() === true, "close reports true");
  check(app.close() === false, "second close reports false");
}

module.exports = {run: run};
