// Rate limit: fixed window, headers, keys, skip, reset, expiry.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

test("ratelimit: window, headers, reset, clear", async () => {
  var app = concarne();
  var limiter = concarne.rateLimit({windowMs: 60000, limit: 2});
  app.use(limiter);
  app.get("/data", (req, res) => res.json({ok: true}));
  app.get("/ip", (req, res) => res.json({ip: req.ip}));
  var srv = app.listen(18441);
  expect(srv.port).toBe(18441);

  var r = await http.get("http://127.0.0.1:18441/ip");
  var ip = JSON.parse(r.body).ip;
  expect(typeof ip).toBe("string");
  expect(ip.length > 0).toBe(true);
  limiter.clear();

  r = await http.get("http://127.0.0.1:18441/data");
  expect(r.status).toBe(200);
  expect(r.headers["ratelimit-limit"]).toBe("2");
  expect(r.headers["ratelimit-remaining"]).toBe("1");
  expect(r.headers["ratelimit-reset"] !== undefined).toBe(true);

  r = await http.get("http://127.0.0.1:18441/data");
  expect(r.status).toBe(200);
  expect(r.headers["ratelimit-remaining"]).toBe("0");

  r = await http.get("http://127.0.0.1:18441/data");
  expect(r.status).toBe(429);
  expect(r.body).toBe("Too many requests");
  expect(r.headers["retry-after"] !== undefined).toBe(true);

  limiter.reset(ip);
  r = await http.get("http://127.0.0.1:18441/data");
  expect(r.status).toBe(200);
  expect(r.headers["ratelimit-remaining"]).toBe("1");
  limiter.clear();
  r = await http.get("http://127.0.0.1:18441/data");
  expect(r.status).toBe(200);
  expect(r.headers["ratelimit-remaining"]).toBe("1");
  expect(app.close()).toBe(true);
});

test("ratelimit: custom keys isolate clients", async () => {
  var app = concarne();
  app.use(concarne.rateLimit({
    windowMs: 60000,
    limit: 1,
    key: function (req) { return req.path; }
  }));
  app.get("/a", (req, res) => res.send("a"));
  app.get("/b", (req, res) => res.send("b"));
  app.listen(18442);

  var r = await http.get("http://127.0.0.1:18442/a");
  expect(r.status).toBe(200);
  r = await http.get("http://127.0.0.1:18442/a");
  expect(r.status).toBe(429);
  r = await http.get("http://127.0.0.1:18442/b");
  expect(r.status).toBe(200);
  expect(app.close()).toBe(true);
});

test("ratelimit: skip bypasses, onLimit overrides", async () => {
  // NOTE: one server at a time. std/http goes deaf on the next serve
  // after two overlapping servers have closed in one run (minimal raw
  // std/http repro confirmed, filed carne-side), so each suite here
  // uses its own ports instead of rebinding a closed one.
  var app = concarne();
  var seen = [];
  app.use(concarne.rateLimit({
    windowMs: 60000,
    limit: 1,
    headers: false,
    message: {error: "slow down"},
    skip: function (req) { return req.path === "/free"; },
    onLimit: function (req, res) {
      seen.push(req.path);
      res.status(429).json({custom: true});
    }
  }));
  app.get("/free", (req, res) => res.send("free"));
  app.get("/paid", (req, res) => res.send("paid"));
  app.listen(18443);

  var r = await http.get("http://127.0.0.1:18443/free");
  expect(r.status).toBe(200);
  expect(r.headers["ratelimit-limit"]).toBe(undefined);
  r = await http.get("http://127.0.0.1:18443/free");
  expect(r.status).toBe(200);

  r = await http.get("http://127.0.0.1:18443/paid");
  expect(r.status).toBe(200);
  r = await http.get("http://127.0.0.1:18443/paid");
  expect(r.status).toBe(429);
  expect(JSON.parse(r.body).custom).toBe(true);
  expect(seen.length).toBe(1);
  expect(seen[0]).toBe("/paid");
  expect(app.close()).toBe(true);
});

test("ratelimit: windows expire, bad opts throw", async () => {
  var app = concarne();
  app.use(concarne.rateLimit({windowMs: 100, limit: 1}));
  app.get("/data", (req, res) => res.send("x"));
  app.listen(18444);
  var r = await http.get("http://127.0.0.1:18444/data");
  expect(r.status).toBe(200);
  r = await http.get("http://127.0.0.1:18444/data");
  expect(r.status).toBe(429);
  var reopened = false;
  for (var i = 0; i < 100; i++) {
    await wait(30);
    r = await http.get("http://127.0.0.1:18444/data");
    if (r.status === 200) {
      reopened = true;
      break;
    }
  }
  expect(reopened).toBe(true);
  expect(app.close()).toBe(true);

  var threw = 0;
  try { concarne.rateLimit({windowMs: 0}); } catch (e) { threw++; }
  try { concarne.rateLimit({limit: 0}); } catch (e) { threw++; }
  try { concarne.rateLimit({max: 1.5}); } catch (e) { threw++; }
  try { concarne.rateLimit({key: "ip"}); } catch (e) { threw++; }
  try { concarne.rateLimit({statusCode: 200}); } catch (e) { threw++; }
  try { concarne.rateLimit({skip: true}); } catch (e) { threw++; }
  expect(threw).toBe(6);
});
