// Bodies: query parsing, JSON/urlencoded bodies, cookies, req.get.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

test("bodies: query, JSON/urlencoded bodies, cookies, req.get", async () => {
  var app = concarne();
  app.get("/q", (req, res) => res.json(req.query));
  app.post("/echo", (req, res) => res.json({got: req.body}));
  app.get("/who", (req, res) => res.json({
    agent: req.get("User-Agent"),
    agentUpper: req.get("USER-AGENT"),
    session: req.cookies.session,
    theme: req.cookies.theme,
    missing: req.cookies.nope || null
  }));
  app.get("/typed", (req, res) => res.type("js").send("1"));
  app.get("/marked", (req, res) => res.type("xml").send("<a/>"));
  app.listen(18403);

  var r = await http.get("http://127.0.0.1:18403/q?a=1&b=x+y&c&c=2&empty=");
  var q = JSON.parse(r.body);
  expect(q.a).toBe("1");
  expect(q.b).toBe("x y");
  expect(q.c).toEqual(["", "2"]);
  expect(q.empty).toBe("");

  r = await http.post("http://127.0.0.1:18403/echo", '{"n":7,"t":"hi"}',
    {headers: {"content-type": "application/json"}});
  expect(JSON.parse(r.body).got.n).toBe(7);

  r = await http.post("http://127.0.0.1:18403/echo", "a=1&b=2",
    {headers: {"content-type": "application/x-www-form-urlencoded"}});
  expect(JSON.parse(r.body).got.a).toBe("1");

  r = await http.post("http://127.0.0.1:18403/echo", "plain text",
    {headers: {"content-type": "text/plain"}});
  expect(JSON.parse(r.body).got).toBe("plain text");

  r = await http.post("http://127.0.0.1:18403/echo", "{oops",
    {headers: {"content-type": "application/json"}});
  expect(r.status).toBe(400);
  expect(JSON.parse(r.body).error).toBe("Invalid JSON body");

  r = await http.get("http://127.0.0.1:18403/who",
    {headers: {"user-agent": "carne-test", "cookie": "session=abc; theme=dark"}});
  var who = JSON.parse(r.body);
  expect(who.agent).toBe("carne-test");
  expect(who.agentUpper).toBe("carne-test");
  expect(who.session).toBe("abc");
  expect(who.theme).toBe("dark");

  r = await http.get("http://127.0.0.1:18403/typed");
  expect(r.headers["content-type"]).toBe("application/javascript; charset=utf-8");
  r = await http.get("http://127.0.0.1:18403/marked");
  expect(r.headers["content-type"]).toBe("text/xml; charset=utf-8");
  expect(who.missing).toBe(null);

  app.close();
});
