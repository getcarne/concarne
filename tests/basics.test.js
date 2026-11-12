// Basics: send/json/status/redirect/404/trailing slash.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

test("basics: send, json, status, redirect, 404", async () => {
  var app = concarne();
  app.get("/hi", (req, res) => res.send("hi ada"));
  app.get("/created", (req, res) => res.status(201).json({made: true}));
  app.get("/old", (req, res) => res.redirect("/hi"));
  app.get("/num", (req, res) => res.send(404));
  var srv = app.listen(18401);
  expect(srv.port).toBe(18401);

  var r = await http.get("http://127.0.0.1:18401/hi");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hi ada");
  expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");

  r = await http.get("http://127.0.0.1:18401/hi/");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hi ada");

  r = await http.get("http://127.0.0.1:18401/created");
  expect(r.status).toBe(201);
  expect(JSON.parse(r.body).made).toBe(true);
  expect(r.headers["content-type"]).toBe("application/json; charset=utf-8");

  r = await http.get("http://127.0.0.1:18401/old");
  expect(r.status).toBe(302);
  expect(r.headers["location"]).toBe("/hi");

  r = await http.get("http://127.0.0.1:18401/num");
  expect(r.status).toBe(404);
  expect(r.body).toBe("Not Found");

  r = await http.get("http://127.0.0.1:18401/nope");
  expect(r.status).toBe(404);
  var miss = JSON.parse(r.body);
  expect(miss.error).toBe("Not Found");
  expect(miss.path).toBe("/nope");

  expect(app.close()).toBe(true);
  expect(app.close()).toBe(false);
});
