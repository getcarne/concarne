// Static serving: files, indexes, redirects, 304s, fallthrough.
var http = require("std/http");
var concarne = require("../index.js");
var check = require("./helper.js").check;

var ROOT = "tests/fixtures/public";

async function run() {
  var app = concarne();
  app.use(concarne.static(ROOT, {maxAge: 60}));
  app.use(function (req, res, next) {
    res.set("X-Fell-Through", "yes");
    next();
  });
  app.get("/late", (req, res) => res.send("late route"));
  var srv = app.listen(18430);

  var r = await http.get("http://127.0.0.1:18430/hello.txt");
  check(r.status === 200, "GET file is 200");
  check(r.body === "hello static\n", "text file body roundtrips");
  check(r.headers["content-type"] === "text/plain; charset=utf-8", "txt content-type");
  check(r.headers["etag"] !== undefined, "etag header present");
  check(r.headers["last-modified"] !== undefined, "last-modified present");
  check(r.headers["cache-control"] === "public, max-age=60", "max-age honored");

  r = await http.get("http://127.0.0.1:18430/");
  check(r.status === 200 && r.body === "<h1>concarne static</h1>\n", "root index resolves");
  check(r.headers["content-type"] === "text/html; charset=utf-8", "html content-type");

  r = await http.get("http://127.0.0.1:18430/sub/");
  check(r.status === 200 && r.body === "<h1>sub</h1>\n", "sub index resolves");

  r = await http.get("http://127.0.0.1:18430/sub/app.css");
  check(r.status === 200 && r.body === "body { color: red; }\n", "nested file serves");
  check(r.headers["content-type"] === "text/css; charset=utf-8", "css content-type");

  r = await http.get("http://127.0.0.1:18430/sub");
  check(r.status === 301, "bare dir redirects");
  check(r.headers["location"] === "/sub/", "redirect targets slash form");

  // Binary: exact bytes on the wire (content-length 6); the client
  // decodes UTF-8 lossy, so 0xFF arrives as U+FFFD (see std/http).
  r = await http.get("http://127.0.0.1:18430/data.bin");
  var codes = [];
  for (var i = 0; i < r.body.length; i++) codes.push(r.body.charCodeAt(i));
  check(r.status === 200, "binary is 200");
  check(r.headers["content-type"] === "application/octet-stream", "bin content-type");
  check(r.headers["content-length"] === "6", "binary length exact");
  check(JSON.stringify(codes) === "[0,1,2,65533,0,65]", "binary bytes exact");

  // Conditional: etag roundtrip answers 304.
  var etag = (await http.get("http://127.0.0.1:18430/hello.txt")).headers["etag"];
  r = await http.get("http://127.0.0.1:18430/hello.txt", {headers: {"If-None-Match": etag}});
  check(r.status === 304, "matching etag is 304");

  // Misses fall through to app middleware and routes.
  r = await http.get("http://127.0.0.1:18430/nope.txt");
  check(r.status === 404, "miss is 404");
  check(r.headers["x-fell-through"] === "yes", "miss calls next()");
  r = await http.get("http://127.0.0.1:18430/late");
  check(r.status === 200 && r.body === "late route", "routes after static run");

  // Traversal, dotfiles and bad methods all fall through.
  r = await http.get("http://127.0.0.1:18430/../index.js");
  check(r.status === 404 && r.headers["x-fell-through"] === "yes", "traversal is a miss");
  r = await http.get("http://127.0.0.1:18430/..%2f..%2fpackage.json");
  check(r.status === 404, "encoded traversal is a miss");
  r = await http.get("http://127.0.0.1:18430/.hidden");
  check(r.status === 404, "dotfiles are misses");
  r = await http.post("http://127.0.0.1:18430/hello.txt", "x");
  check(r.status === 404, "POST falls through");

  check(app.close() === true, "close reports true");
}

async function runSendFile() {
  var app = concarne();
  app.get("/f", (req, res) => res.sendFile(ROOT + "/hello.txt"));
  app.get("/missing", (req, res) => res.sendFile(ROOT + "/nope.txt"));
  app.get("/bin", (req, res) => res.send(new Uint8Array([104, 105])));
  var srv = app.listen(18431);

  var r = await http.get("http://127.0.0.1:18431/f");
  check(r.status === 200 && r.body === "hello static\n", "sendFile serves");
  check(r.headers["content-type"] === "text/plain; charset=utf-8", "sendFile content-type");
  r = await http.get("http://127.0.0.1:18431/missing");
  check(r.status === 404, "sendFile miss is 404");
  r = await http.get("http://127.0.0.1:18431/bin");
  check(r.status === 200 && r.body === "hi", "res.send binary works");
  check(r.headers["content-type"] === "application/octet-stream", "binary default type");

  check(app.close() === true, "close reports true");
}

async function runStrip() {
  var app = concarne();
  app.use("/assets", concarne.static(ROOT, {strip: "/assets"}));
  var srv = app.listen(18432);

  var r = await http.get("http://127.0.0.1:18432/assets/hello.txt");
  check(r.status === 200 && r.body === "hello static\n", "stripped mount serves");
  r = await http.get("http://127.0.0.1:18432/hello.txt");
  check(r.status === 404, "unstripped path misses");

  check(app.close() === true, "close reports true");
}

module.exports = {run: async function () {
  await run();
  await runSendFile();
  await runStrip();
}};
