// CORS: default allow-all, origin matching, preflight, credentials.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

function originHeaders(origin, extra) {
  var h = {"origin": origin};
  if (extra) {
    for (var k in extra) h[k] = extra[k];
  }
  return h;
}

test("cors: permissive default with 204 preflight", async () => {
  var app = concarne();
  app.use(concarne.cors());
  app.get("/data", (req, res) => res.json({ok: true}));
  var srv = app.listen(18440);
  expect(srv.port).toBe(18440);

  var r = await http.get("http://127.0.0.1:18440/data");
  expect(r.status).toBe(200);
  expect(r.headers["access-control-allow-origin"]).toBe(undefined);

  r = await http.get("http://127.0.0.1:18440/data",
    {headers: originHeaders("https://app.example.com")});
  expect(r.status).toBe(200);
  expect(JSON.parse(r.body).ok).toBe(true);
  expect(r.headers["access-control-allow-origin"]).toBe("*");

  r = await http.options("http://127.0.0.1:18440/data",
    {headers: originHeaders("https://app.example.com",
      {"access-control-request-method": "POST", "access-control-request-headers": "x-token"})});
  expect(r.status).toBe(204);
  expect(r.headers["access-control-allow-origin"]).toBe("*");
  expect(r.headers["access-control-allow-methods"].indexOf("POST") >= 0).toBe(true);
  expect(r.headers["access-control-allow-headers"]).toBe("x-token");
  expect(app.close()).toBe(true);
});

test("cors: exact string origin echoes on match only", async () => {
  var app = concarne();
  app.use(concarne.cors({origin: "https://app.example.com"}));
  app.get("/data", (req, res) => res.send("x"));
  app.listen(18445);

  var r = await http.get("http://127.0.0.1:18445/data",
    {headers: originHeaders("https://app.example.com")});
  expect(r.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  expect((r.headers["vary"] || "").indexOf("Origin") >= 0).toBe(true);

  r = await http.get("http://127.0.0.1:18445/data",
    {headers: originHeaders("https://evil.example.com")});
  expect(r.status).toBe(200);
  expect(r.headers["access-control-allow-origin"]).toBe(undefined);
  expect(app.close()).toBe(true);
});

test("cors: array, function and credentials forms", async () => {
  var app = concarne();
  app.use("/arr", concarne.cors({origin: ["https://a.example.com", "https://b.example.com"]}));
  app.get("/arr", (req, res) => res.send("a"));
  app.use("/fn", concarne.cors({origin: function (o) { return o.slice(-12) === ".example.com"; }}));
  app.get("/fn", (req, res) => res.send("f"));
  app.use("/cred", concarne.cors({credentials: true, maxAge: 600,
    exposedHeaders: "X-Total", methods: "GET, POST"}));
  app.get("/cred", (req, res) => res.send("c"));
  app.listen(18446);

  var r = await http.get("http://127.0.0.1:18446/arr",
    {headers: originHeaders("https://b.example.com")});
  expect(r.headers["access-control-allow-origin"]).toBe("https://b.example.com");
  r = await http.get("http://127.0.0.1:18446/arr",
    {headers: originHeaders("https://c.example.com")});
  expect(r.headers["access-control-allow-origin"]).toBe(undefined);

  r = await http.get("http://127.0.0.1:18446/fn",
    {headers: originHeaders("https://deep.example.com")});
  expect(r.headers["access-control-allow-origin"]).toBe("https://deep.example.com");
  r = await http.get("http://127.0.0.1:18446/fn",
    {headers: originHeaders("https://other.example.org")});
  expect(r.headers["access-control-allow-origin"]).toBe(undefined);

  r = await http.options("http://127.0.0.1:18446/cred",
    {headers: originHeaders("https://app.example.com",
      {"access-control-request-method": "GET"})});
  expect(r.headers["access-control-allow-origin"]).toBe("https://app.example.com");
  expect(r.headers["access-control-allow-credentials"]).toBe("true");
  expect(r.headers["access-control-max-age"]).toBe("600");
  expect(r.headers["access-control-expose-headers"]).toBe("X-Total");
  expect(r.headers["access-control-allow-methods"]).toBe("GET, POST");
  expect(app.close()).toBe(true);
});

test("cors: optionsSuccessStatus, preflightContinue, factory validation", async () => {
  var app = concarne();
  app.use(concarne.cors({optionsSuccessStatus: 200}));
  app.get("/data", (req, res) => res.send("hit"));
  app.listen(18447);
  var r = await http.options("http://127.0.0.1:18447/data",
    {headers: originHeaders("https://app.example.com",
      {"access-control-request-method": "GET"})});
  expect(r.status).toBe(200);
  expect(app.close()).toBe(true);

  var app2 = concarne();
  var continued = false;
  app2.use(concarne.cors({preflightContinue: true}));
  app2.all("/data", (req, res) => {
    continued = true;
    return res.send("route saw it");
  });
  app2.listen(18448);
  r = await http.options("http://127.0.0.1:18448/data",
    {headers: originHeaders("https://app.example.com",
      {"access-control-request-method": "GET"})});
  expect(r.status).toBe(200);
  expect(r.body).toBe("route saw it");
  expect(continued).toBe(true);
  expect(app2.close()).toBe(true);

  var threw = 0;
  try { concarne.cors({origin: 42}); } catch (e) { threw++; }
  try { concarne.cors({maxAge: -1}); } catch (e) { threw++; }
  try { concarne.cors({optionsSuccessStatus: 404}); } catch (e) { threw++; }
  expect(threw).toBe(3);
});
