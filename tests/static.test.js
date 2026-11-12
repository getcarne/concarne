// Static serving: files, indexes, redirects, 304s, fallthrough.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

var ROOT = "tests/fixtures/public";

test("static: files, indexes, redirects, etags, fallthrough", async () => {
  var app = concarne();
  app.use(concarne.static(ROOT, {maxAge: 60}));
  app.use(function (req, res, next) {
    res.set("X-Fell-Through", "yes");
    next();
  });
  app.get("/late", (req, res) => res.send("late route"));
  app.listen(18430);

  var r = await http.get("http://127.0.0.1:18430/hello.txt");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hello static\n");
  expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
  expect(r.headers["etag"] !== undefined).toBe(true);
  expect(r.headers["last-modified"] !== undefined).toBe(true);
  expect(r.headers["cache-control"]).toBe("public, max-age=60");

  r = await http.get("http://127.0.0.1:18430/");
  expect(r.status).toBe(200);
  expect(r.body).toBe("<h1>concarne static</h1>\n");
  expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");

  r = await http.get("http://127.0.0.1:18430/sub/");
  expect(r.status).toBe(200);
  expect(r.body).toBe("<h1>sub</h1>\n");

  r = await http.get("http://127.0.0.1:18430/sub/app.css");
  expect(r.status).toBe(200);
  expect(r.body).toBe("body { color: red; }\n");
  expect(r.headers["content-type"]).toBe("text/css; charset=utf-8");

  r = await http.get("http://127.0.0.1:18430/sub");
  expect(r.status).toBe(301);
  expect(r.headers["location"]).toBe("/sub/");

  // Binary: exact bytes on the wire (content-length 6); the client
  // decodes UTF-8 lossy, so 0xFF arrives as U+FFFD (see std/http).
  r = await http.get("http://127.0.0.1:18430/data.bin");
  var codes = [];
  for (var i = 0; i < r.body.length; i++) codes.push(r.body.charCodeAt(i));
  expect(r.status).toBe(200);
  expect(r.headers["content-type"]).toBe("application/octet-stream");
  expect(r.headers["content-length"]).toBe("6");
  expect(codes).toEqual([0, 1, 2, 65533, 0, 65]);

  // Conditional: etag roundtrip answers 304.
  var etag = (await http.get("http://127.0.0.1:18430/hello.txt")).headers["etag"];
  r = await http.get("http://127.0.0.1:18430/hello.txt", {headers: {"If-None-Match": etag}});
  expect(r.status).toBe(304);

  // Misses fall through to app middleware and routes.
  r = await http.get("http://127.0.0.1:18430/nope.txt");
  expect(r.status).toBe(404);
  expect(r.headers["x-fell-through"]).toBe("yes");
  r = await http.get("http://127.0.0.1:18430/late");
  expect(r.status).toBe(200);
  expect(r.body).toBe("late route");

  // Traversal, dotfiles and bad methods all fall through.
  r = await http.get("http://127.0.0.1:18430/../index.js");
  expect(r.status).toBe(404);
  expect(r.headers["x-fell-through"]).toBe("yes");
  r = await http.get("http://127.0.0.1:18430/..%2f..%2fpackage.json");
  expect(r.status).toBe(404);
  r = await http.get("http://127.0.0.1:18430/.hidden");
  expect(r.status).toBe(404);
  r = await http.post("http://127.0.0.1:18430/hello.txt", "x");
  expect(r.status).toBe(404);

  expect(app.close()).toBe(true);
});

test("static: res.sendFile and binary res.send", async () => {
  var app = concarne();
  app.get("/f", (req, res) => res.sendFile(ROOT + "/hello.txt"));
  app.get("/missing", (req, res) => res.sendFile(ROOT + "/nope.txt"));
  app.get("/bin", (req, res) => res.send(new Uint8Array([104, 105])));
  app.listen(18431);

  var r = await http.get("http://127.0.0.1:18431/f");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hello static\n");
  expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
  r = await http.get("http://127.0.0.1:18431/missing");
  expect(r.status).toBe(404);
  r = await http.get("http://127.0.0.1:18431/bin");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hi");
  expect(r.headers["content-type"]).toBe("application/octet-stream");

  expect(app.close()).toBe(true);
});

test("static: stripped mount", async () => {
  var app = concarne();
  app.use("/assets", concarne.static(ROOT, {strip: "/assets"}));
  app.listen(18432);

  var r = await http.get("http://127.0.0.1:18432/assets/hello.txt");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hello static\n");
  r = await http.get("http://127.0.0.1:18432/hello.txt");
  expect(r.status).toBe(404);

  expect(app.close()).toBe(true);
});
