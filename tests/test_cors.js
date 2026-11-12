// CORS: default allow-all, origin matching, preflight, credentials.
const http = require("std/http");
const concarne = require("../index.js");
const check = require("./helper.js").check;

function originHeaders(origin, extra) {
  var h = {"origin": origin};
  if (extra) {
    for (var k in extra) h[k] = extra[k];
  }
  return h;
}

async function run() {
  // Default: permissive, preflight ends with 204.
  var app = concarne();
  app.use(concarne.cors());
  app.get("/data", (req, res) => res.json({ok: true}));
  var srv = app.listen(18440);
  check(srv.port === 18440, "cors app listens");

  var r = await http.get("http://127.0.0.1:18440/data");
  check(r.status === 200 && r.headers["access-control-allow-origin"] === undefined,
    "no Origin header means no CORS headers");

  r = await http.get("http://127.0.0.1:18440/data",
    {headers: originHeaders("https://app.example.com")});
  check(r.status === 200 && JSON.parse(r.body).ok === true, "CORS GET passes through");
  check(r.headers["access-control-allow-origin"] === "*", "default origin is *");

  r = await http.options("http://127.0.0.1:18440/data",
    {headers: originHeaders("https://app.example.com",
      {"access-control-request-method": "POST", "access-control-request-headers": "x-token"})});
  check(r.status === 204, "preflight ends with 204");
  check(r.headers["access-control-allow-origin"] === "*", "preflight carries ACAO");
  check(r.headers["access-control-allow-methods"].indexOf("POST") >= 0,
    "preflight lists methods");
  check(r.headers["access-control-allow-headers"] === "x-token",
    "preflight reflects requested headers");
  check(app.close() === true, "cors app closes");

  // Exact string origin: match echoes, mismatch sets nothing.
  var app2 = concarne();
  app2.use(concarne.cors({origin: "https://app.example.com"}));
  app2.get("/data", (req, res) => res.send("x"));
  app2.listen(18445);

  r = await http.get("http://127.0.0.1:18445/data",
    {headers: originHeaders("https://app.example.com")});
  check(r.headers["access-control-allow-origin"] === "https://app.example.com",
    "string origin match echoes");
  check((r.headers["vary"] || "").indexOf("Origin") >= 0,
    "echoed origin adds Vary: Origin");

  r = await http.get("http://127.0.0.1:18445/data",
    {headers: originHeaders("https://evil.example.com")});
  check(r.status === 200 && r.headers["access-control-allow-origin"] === undefined,
    "string origin mismatch sets no ACAO");
  check(app2.close() === true, "string-origin app closes");

  // Array, function, and credentials forms.
  var app3 = concarne();
  app3.use("/arr", concarne.cors({origin: ["https://a.example.com", "https://b.example.com"]}));
  app3.get("/arr", (req, res) => res.send("a"));
  app3.use("/fn", concarne.cors({origin: function (o) { return o.slice(-12) === ".example.com"; }}));
  app3.get("/fn", (req, res) => res.send("f"));
  app3.use("/cred", concarne.cors({credentials: true, maxAge: 600,
    exposedHeaders: "X-Total", methods: "GET, POST"}));
  app3.get("/cred", (req, res) => res.send("c"));
  app3.listen(18446);

  r = await http.get("http://127.0.0.1:18446/arr",
    {headers: originHeaders("https://b.example.com")});
  check(r.headers["access-control-allow-origin"] === "https://b.example.com",
    "array origin match echoes");
  r = await http.get("http://127.0.0.1:18446/arr",
    {headers: originHeaders("https://c.example.com")});
  check(r.headers["access-control-allow-origin"] === undefined,
    "array origin mismatch sets nothing");

  r = await http.get("http://127.0.0.1:18446/fn",
    {headers: originHeaders("https://deep.example.com")});
  check(r.headers["access-control-allow-origin"] === "https://deep.example.com",
    "function origin reflects on true");
  r = await http.get("http://127.0.0.1:18446/fn",
    {headers: originHeaders("https://other.example.org")});
  check(r.headers["access-control-allow-origin"] === undefined,
    "function origin denies on false");

  r = await http.options("http://127.0.0.1:18446/cred",
    {headers: originHeaders("https://app.example.com",
      {"access-control-request-method": "GET"})});
  check(r.headers["access-control-allow-origin"] === "https://app.example.com",
    "credentials reflects instead of *");
  check(r.headers["access-control-allow-credentials"] === "true",
    "credentials header set");
  check(r.headers["access-control-max-age"] === "600", "max-age set");
  check(r.headers["access-control-expose-headers"] === "X-Total",
    "exposed headers set");
  check(r.headers["access-control-allow-methods"] === "GET, POST",
    "custom methods list used");
  check(app3.close() === true, "multi-form app closes");

  // optionsSuccessStatus, preflightContinue, bad opts.
  var app4 = concarne();
  app4.use(concarne.cors({optionsSuccessStatus: 200}));
  app4.get("/data", (req, res) => res.send("hit"));
  app4.listen(18447);
  r = await http.options("http://127.0.0.1:18447/data",
    {headers: originHeaders("https://app.example.com",
      {"access-control-request-method": "GET"})});
  check(r.status === 200, "custom preflight status");
  check(app4.close() === true, "status app closes");

  var app5 = concarne();
  var continued = false;
  app5.use(concarne.cors({preflightContinue: true}));
  app5.all("/data", (req, res) => {
    continued = true;
    return res.send("route saw it");
  });
  app5.listen(18448);
  r = await http.options("http://127.0.0.1:18448/data",
    {headers: originHeaders("https://app.example.com",
      {"access-control-request-method": "GET"})});
  check(r.status === 200 && r.body === "route saw it" && continued === true,
    "preflightContinue reaches the route");
  check(app5.close() === true, "continue app closes");

  var threw = 0;
  try { concarne.cors({origin: 42}); } catch (e) { threw++; }
  try { concarne.cors({maxAge: -1}); } catch (e) { threw++; }
  try { concarne.cors({optionsSuccessStatus: 404}); } catch (e) { threw++; }
  check(threw === 3, "bad cors opts throw at factory time");
}

module.exports = {run: run};
