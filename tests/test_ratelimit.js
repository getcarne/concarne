// Rate limit: fixed window, headers, keys, skip, reset, expiry.
const http = require("std/http");
const concarne = require("../index.js");
const check = require("./helper.js").check;

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function run() {
  var app = concarne();
  var limiter = concarne.rateLimit({windowMs: 60000, limit: 2});
  app.use(limiter);
  app.get("/data", (req, res) => res.json({ok: true}));
  app.get("/ip", (req, res) => res.json({ip: req.ip}));
  var srv = app.listen(18441);
  check(srv.port === 18441, "ratelimit app listens");

  var r = await http.get("http://127.0.0.1:18441/ip");
  var ip = JSON.parse(r.body).ip;
  check(typeof ip === "string" && ip.length > 0, "req.ip carries the peer (" + ip + ")");
  limiter.clear();

  r = await http.get("http://127.0.0.1:18441/data");
  check(r.status === 200, "first request passes");
  check(r.headers["ratelimit-limit"] === "2", "limit header");
  check(r.headers["ratelimit-remaining"] === "1", "remaining counts down");
  check(r.headers["ratelimit-reset"] !== undefined, "reset header present");

  r = await http.get("http://127.0.0.1:18441/data");
  check(r.status === 200 && r.headers["ratelimit-remaining"] === "0",
    "second request passes at zero remaining");

  r = await http.get("http://127.0.0.1:18441/data");
  check(r.status === 429, "third request is limited");
  check(r.body === "Too many requests", "default message body");
  check(r.headers["retry-after"] !== undefined, "retry-after on 429");

  limiter.reset(ip);
  r = await http.get("http://127.0.0.1:18441/data");
  check(r.status === 200 && r.headers["ratelimit-remaining"] === "1",
    "reset(key) clears one client");
  limiter.clear();
  r = await http.get("http://127.0.0.1:18441/data");
  check(r.status === 200 && r.headers["ratelimit-remaining"] === "1",
    "clear() empties the store");
  check(app.close() === true, "ratelimit app closes");

  // Custom keys isolate clients; skip bypasses; onLimit overrides.
  var app2 = concarne();
  app2.use(concarne.rateLimit({
    windowMs: 60000,
    limit: 1,
    key: function (req) { return req.path; }
  }));
  app2.get("/a", (req, res) => res.send("a"));
  app2.get("/b", (req, res) => res.send("b"));
  app2.listen(18442);

  r = await http.get("http://127.0.0.1:18442/a");
  check(r.status === 200, "path-keyed first hit passes");
  r = await http.get("http://127.0.0.1:18442/a");
  check(r.status === 429, "same path limited");
  r = await http.get("http://127.0.0.1:18442/b");
  check(r.status === 200, "other path unaffected");
  check(app2.close() === true, "keyed app closes");

  // NOTE: one server at a time. std/http goes deaf on the next serve
  // after two overlapping servers have closed in one run (minimal raw
  // std/http repro confirmed, filed carne-side), so app2 closes before
  // app3 opens. Same reason every suite here uses its own ports
  // instead of rebinding a closed one.
  var app3 = concarne();
  var seen = [];
  app3.use(concarne.rateLimit({
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
  app3.get("/free", (req, res) => res.send("free"));
  app3.get("/paid", (req, res) => res.send("paid"));
  app3.listen(18443);

  r = await http.get("http://127.0.0.1:18443/free");
  check(r.status === 200 && r.headers["ratelimit-limit"] === undefined,
    "skipped requests bypass counting and headers");
  r = await http.get("http://127.0.0.1:18443/free");
  check(r.status === 200, "skipped requests never limit");

  r = await http.get("http://127.0.0.1:18443/paid");
  check(r.status === 200, "metered route passes once");
  r = await http.get("http://127.0.0.1:18443/paid");
  check(r.status === 429 && JSON.parse(r.body).custom === true,
    "onLimit replaces the default responder");
  check(seen.length === 1 && seen[0] === "/paid", "onLimit saw the request");
  check(app3.close() === true, "skip app closes");

  // Windows expire: limit 1 per 100ms, poll until the next window.
  var app4 = concarne();
  app4.use(concarne.rateLimit({windowMs: 100, limit: 1}));
  app4.get("/data", (req, res) => res.send("x"));
  app4.listen(18444);
  r = await http.get("http://127.0.0.1:18444/data");
  check(r.status === 200, "window opens");
  r = await http.get("http://127.0.0.1:18444/data");
  check(r.status === 429, "window caps");
  var reopened = false;
  for (var i = 0; i < 100; i++) {
    await wait(30);
    r = await http.get("http://127.0.0.1:18444/data");
    if (r.status === 200) {
      reopened = true;
      break;
    }
  }
  check(reopened === true, "a new window reopens");
  check(app4.close() === true, "window app closes");

  var threw = 0;
  try { concarne.rateLimit({windowMs: 0}); } catch (e) { threw++; }
  try { concarne.rateLimit({limit: 0}); } catch (e) { threw++; }
  try { concarne.rateLimit({max: 1.5}); } catch (e) { threw++; }
  try { concarne.rateLimit({key: "ip"}); } catch (e) { threw++; }
  try { concarne.rateLimit({statusCode: 200}); } catch (e) { threw++; }
  try { concarne.rateLimit({skip: true}); } catch (e) { threw++; }
  check(threw === 6, "bad rateLimit opts throw at factory time");
}

module.exports = {run: run};
