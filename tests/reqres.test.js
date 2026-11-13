// req/res surface: cookies, helpers, negotiation, identity, trust proxy.
const { test, expect } = require("std/test");
const http = require("std/http");
const tcp = require("std/tcp");
const concarne = require("../index.js");

var ROOT = "tests/fixtures/public";

test("reqres: cookies, helpers, negotiation, identity", async () => {
  var app = concarne();
  app.get("/cookies", (req, res) => {
    res.cookie("a", "1", {httpOnly: true})
       .cookie("b", "x y", {maxAge: 60, sameSite: "lax"});
    res.send("ok");
  });
  app.get("/clear", (req, res) => {
    res.clearCookie("a", {path: "/"});
    res.send("gone");
  });
  app.get("/loc", (req, res) => res.location("/there").status(201).end(""));
  app.get("/back", (req, res) => res.redirect("back"));
  app.get("/links", (req, res) => {
    res.links({next: "/p2", last: "/p9"});
    res.send("l");
  });
  app.get("/vary", (req, res) => {
    res.vary("Accept");
    res.vary(["Accept", "X-Foo"]);
    res.send("v");
  });
  app.get("/status", (req, res) => res.sendStatus(404));
  app.get("/who", (req, res) => res.json({
    ip: req.ip, host: req.hostname, proto: req.protocol,
    secure: req.secure, xhr: req.xhr
  }));
  app.get("/dl", (req, res) => res.download(ROOT + "/hello.txt"));
  app.get("/dl-name", (req, res) =>
    res.download(ROOT + "/hello.txt", "greeting.txt"));
  app.get("/att", (req, res) => res.attachment("a.zip").end("x"));
  app.get("/fmt", (req, res) => res.format({
    html: () => res.send("<h1>hi</h1>"),
    json: () => res.json({hi: true})
  }));
  app.listen(18453);

  // Two cookies go out as two Set-Cookie headers on the wire.
  var raw = "";
  var closed = false;
  const c = await tcp.connect("127.0.0.1", 18453, {
    onData: (chunk) => { raw += chunk; },
    onClose: () => { closed = true; }
  });
  c.write("GET /cookies HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  for (var i = 0; i < 200 && !closed; i++) await sleep(5);
  var setCookies = raw.split("\r\n").filter((l) =>
    l.toLowerCase().indexOf("set-cookie:") === 0);
  expect(setCookies.length).toBe(2);
  expect(setCookies[0]).toBe("Set-Cookie: a=1; Path=/; HttpOnly");
  expect(setCookies[1].indexOf("Set-Cookie: b=x%20y;") === 0).toBe(true);
  expect(setCookies[1].indexOf("Max-Age=60") >= 0).toBe(true);
  expect(setCookies[1].indexOf("SameSite=Lax") >= 0).toBe(true);
  c.close();

  var r = await http.get("http://127.0.0.1:18453/clear");
  expect(r.body).toBe("gone");
  expect(r.headers["set-cookie"].indexOf("a=;") === 0).toBe(true);
  expect(r.headers["set-cookie"].indexOf("Expires=Thu, 01 Jan 1970") >= 0).toBe(true);

  r = await http.get("http://127.0.0.1:18453/loc");
  expect(r.status).toBe(201);
  expect(r.headers["location"]).toBe("/there");

  r = await http.get("http://127.0.0.1:18453/back",
    {headers: {Referer: "http://x/came"}});
  expect(r.status).toBe(302);
  expect(r.headers["location"]).toBe("http://x/came");

  r = await http.get("http://127.0.0.1:18453/links");
  expect(r.headers["link"]).toBe("</p2>; rel=\"next\", </p9>; rel=\"last\"");

  r = await http.get("http://127.0.0.1:18453/vary");
  expect(r.headers["vary"]).toBe("Accept, X-Foo");

  r = await http.get("http://127.0.0.1:18453/status");
  expect(r.status).toBe(404);
  expect(r.body).toBe("Not Found");

  r = await http.get("http://127.0.0.1:18453/who",
    {headers: {"X-Requested-With": "XMLHttpRequest"}});
  var who = JSON.parse(r.body);
  expect(who.proto).toBe("http");
  expect(who.secure).toBe(false);
  expect(who.xhr).toBe(true);
  expect(typeof who.host).toBe("string");

  r = await http.get("http://127.0.0.1:18453/dl");
  expect(r.headers["content-disposition"]).toBe("attachment; filename=\"hello.txt\"");
  expect(r.body).toBe("hello static\n");

  r = await http.get("http://127.0.0.1:18453/dl-name");
  expect(r.headers["content-disposition"]).toBe("attachment; filename=\"greeting.txt\"");

  r = await http.get("http://127.0.0.1:18453/att");
  expect(r.headers["content-disposition"]).toBe("attachment; filename=\"a.zip\"");

  r = await http.get("http://127.0.0.1:18453/fmt",
    {headers: {Accept: "application/json"}});
  expect(JSON.parse(r.body).hi).toBe(true);
  r = await http.get("http://127.0.0.1:18453/fmt",
    {headers: {Accept: "text/html"}});
  expect(r.body).toBe("<h1>hi</h1>");
  r = await http.get("http://127.0.0.1:18453/fmt",
    {headers: {Accept: "application/pdf"}});
  expect(r.status).toBe(406);

  // No Accept header: the server's first choice wins.
  r = await http.fetch("http://127.0.0.1:18453/fmt");
  expect(r.body).toBe("<h1>hi</h1>");

  app.close();
});

test("reqres: trust proxy and settings", async () => {
  var app = concarne();
  expect(app.get("trust proxy")).toBe(undefined);
  expect(app.disabled("trust proxy")).toBe(true);
  app.enable("trust proxy");
  expect(app.enabled("trust proxy")).toBe(true);
  expect(app.get("trust proxy")).toBe(true);
  app.get("/who", (req, res) => res.json({
    ip: req.ip, host: req.hostname, proto: req.protocol, secure: req.secure
  }));
  app.listen(18454);

  var r = await http.get("http://127.0.0.1:18454/who", {headers: {
    "X-Forwarded-For": "9.9.9.9, 10.0.0.1",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "example.com"
  }});
  var who = JSON.parse(r.body);
  expect(who.ip).toBe("9.9.9.9");
  expect(who.host).toBe("example.com");
  expect(who.proto).toBe("https");
  expect(who.secure).toBe(true);

  app.disable("trust proxy");
  expect(app.enabled("trust proxy")).toBe(false);
  expect(app.set("mode", "dev")).toBe(app);
  expect(app.get("mode")).toBe("dev");

  app.close();
});
