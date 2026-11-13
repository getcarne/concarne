// Zero-copy file serving: ranges, conditionals, HEAD, downloads,
// media streams. Bytes go out via sendfile (no body buffering), with
// ETag/Last-Modified/Accept-Ranges owned by the file serving itself.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

var ROOT = "tests/fixtures/public";

test("files: sendFile ranges, conditionals, HEAD", async () => {
  var app = concarne();
  app.get("/f", (req, res) => res.sendFile(ROOT + "/hello.txt"));
  app.get("/missing", (req, res) => res.sendFile(ROOT + "/nope.txt"));
  app.listen(18462);

  var r = await http.get("http://127.0.0.1:18462/f");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hello static\n");
  expect(r.headers["content-type"]).toBe("text/plain");
  expect(r.headers["accept-ranges"]).toBe("bytes");
  expect(r.headers["content-length"]).toBe("13");
  var etag = r.headers["etag"];
  expect(typeof etag).toBe("string");
  expect(etag.length > 0).toBe(true);
  expect(typeof r.headers["last-modified"]).toBe("string");

  r = await http.fetch("http://127.0.0.1:18462/f",
    {headers: {Range: "bytes=0-4"}});
  expect(r.status).toBe(206);
  expect(r.body).toBe("hello");
  expect(r.headers["content-range"]).toBe("bytes 0-4/13");

  r = await http.fetch("http://127.0.0.1:18462/f",
    {headers: {"If-None-Match": etag}});
  expect(r.status).toBe(304);
  expect(r.body).toBe("");

  r = await http.fetch("http://127.0.0.1:18462/f", {method: "HEAD"});
  expect(r.status).toBe(200);
  expect(r.body).toBe("");
  expect(r.headers["content-type"]).toBe("text/plain");
  expect(r.headers["accept-ranges"]).toBe("bytes");
  expect(typeof r.headers["etag"]).toBe("string");

  r = await http.fetch("http://127.0.0.1:18462/f",
    {headers: {Range: "bytes=99-100"}});
  expect(r.status).toBe(416);

  r = await http.get("http://127.0.0.1:18462/missing");
  expect(r.status).toBe(404);
  expect(JSON.parse(r.body).error).toBe("Not Found");

  app.close();
});

test("files: download and streamFile", async () => {
  var app = concarne();
  app.get("/dl", (req, res) => res.download(ROOT + "/hello.txt"));
  app.get("/dl-name", (req, res) =>
    res.download(ROOT + "/hello.txt", "greet.txt"));
  app.get("/stream", (req, res) => res.streamFile(ROOT + "/hello.txt"));
  app.get("/stream-chunk", (req, res) =>
    res.streamFile(ROOT + "/hello.txt", 4));
  app.get("/stream-bad", (req, res) =>
    res.streamFile(ROOT + "/hello.txt", 0));
  app.listen(18463);

  var r = await http.get("http://127.0.0.1:18463/dl");
  expect(r.status).toBe(200);
  expect(r.body).toBe("hello static\n");
  expect(r.headers["content-disposition"]).toBe(
    "attachment; filename=\"hello.txt\"");

  r = await http.get("http://127.0.0.1:18463/dl-name");
  expect(r.headers["content-disposition"]).toBe(
    "attachment; filename=\"greet.txt\"");

  // Media streams answer 206 first, capped per response.
  r = await http.get("http://127.0.0.1:18463/stream");
  expect(r.status).toBe(206);
  expect(r.body).toBe("hello static\n");
  expect(r.headers["content-range"]).toBe("bytes 0-12/13");

  r = await http.get("http://127.0.0.1:18463/stream-chunk");
  expect(r.status).toBe(206);
  expect(r.body).toBe("hell");
  expect(r.headers["content-range"]).toBe("bytes 0-3/13");

  // Bad chunk sizes throw in the handler: a 500, not a hang.
  r = await http.get("http://127.0.0.1:18463/stream-bad");
  expect(r.status).toBe(500);

  app.close();
});
