// Bodies: query parsing, JSON/urlencoded bodies, cookies, req.get.
const http = require("std/http");
const concarne = require("../index.js");
const check = require("./helper.js").check;

async function run() {
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
  check(q.a === "1", "query scalar");
  check(q.b === "x y", "query plus decodes to space");
  check(JSON.stringify(q.c) === '["","2"]', "repeated query key becomes an array");
  check(q.empty === "", "empty query value");

  r = await http.post("http://127.0.0.1:18403/echo", '{"n":7,"t":"hi"}',
    {headers: {"content-type": "application/json"}});
  check(JSON.parse(r.body).got.n === 7, "JSON body parses");

  r = await http.post("http://127.0.0.1:18403/echo", "a=1&b=2",
    {headers: {"content-type": "application/x-www-form-urlencoded"}});
  check(JSON.parse(r.body).got.a === "1", "urlencoded body parses");

  r = await http.post("http://127.0.0.1:18403/echo", "plain text",
    {headers: {"content-type": "text/plain"}});
  check(JSON.parse(r.body).got === "plain text", "other bodies stay strings");

  r = await http.post("http://127.0.0.1:18403/echo", "{oops",
    {headers: {"content-type": "application/json"}});
  check(r.status === 400, "invalid JSON is a 400");
  check(JSON.parse(r.body).error === "Invalid JSON body", "invalid JSON error shape");

  r = await http.get("http://127.0.0.1:18403/who",
    {headers: {"user-agent": "carne-test", "cookie": "session=abc; theme=dark"}});
  var who = JSON.parse(r.body);
  check(who.agent === "carne-test", "req.get reads headers");
  check(who.agentUpper === "carne-test", "req.get is case-insensitive");
  check(who.session === "abc" && who.theme === "dark", "cookies parse");

  r = await http.get("http://127.0.0.1:18403/typed");
  check(r.headers["content-type"] === "application/javascript; charset=utf-8",
    "type(js) resolves via std/mimetype");
  r = await http.get("http://127.0.0.1:18403/marked");
  check(r.headers["content-type"] === "text/xml; charset=utf-8",
    "type(xml) resolves via std/mimetype");
  check(who.missing === null, "missing cookie is undefined");

  app.close();
}

module.exports = {run: run};
