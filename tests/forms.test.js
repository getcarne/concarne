// Forms: multipart fields/files on the powpow backend, json/urlencoded
// body limits. Uploads stream to tmpfiles from the first body byte,
// so file data here is binary-safe (NULs survive); tmp paths vanish
// after the handler returns.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");

var BOUNDARY = "concarne-test-boundary";

function part(headers, body) {
  return "--" + BOUNDARY + "\r\n" + headers + "\r\n\r\n" + body + "\r\n";
}

test("forms: multipart fields, repeated names, files, binary", async () => {
  var app = concarne();
  app.post("/upload", (req, res) => {
    var files = req.files.map(function (f) {
      return {
        field: f.field,
        filename: f.filename,
        contentType: f.contentType,
        size: f.size,
        head: Array.prototype.slice.call(f.data.slice(0, 4))
      };
    });
    res.json({fields: req.body, files: files});
  });
  app.listen(18455);

  var body =
    part('Content-Disposition: form-data; name="title"', "hello") +
    part('Content-Disposition: form-data; name="tags"', "a") +
    part('Content-Disposition: form-data; name="tags"', "b") +
    part('Content-Disposition: form-data; name="file"; filename="note.txt"\r\n' +
      "Content-Type: text/plain", "file contents here") +
    part('Content-Disposition: form-data; name="nul"; filename="n.bin"\r\n' +
      "Content-Type: application/octet-stream", "A\0B") +
    "--" + BOUNDARY + "--\r\n";
  var r = await http.post("http://127.0.0.1:18455/upload", body,
    {headers: {"Content-Type": "multipart/form-data; boundary=" + BOUNDARY}});
  expect(r.status).toBe(200);
  var got = JSON.parse(r.body);
  expect(got.fields).toEqual({title: "hello", tags: ["a", "b"]});
  expect(got.files.length).toBe(2);
  expect(got.files[0].field).toBe("file");
  expect(got.files[0].filename).toBe("note.txt");
  expect(got.files[0].contentType).toBe("text/plain");
  expect(got.files[0].size).toBe(18);
  expect(got.files[0].head).toEqual([102, 105, 108, 101]);
  // NUL bytes survive the upload: binary-safe end to end.
  expect(got.files[1].size).toBe(3);
  expect(got.files[1].head.slice(0, 3)).toEqual([65, 0, 66]);

  // A filename without a Content-Type reads as a text field: that is
  // the parser's file/text split (curl and browsers always send both).
  var r2 = await http.post("http://127.0.0.1:18455/upload",
    part('Content-Disposition: form-data; name="f"; filename="x.txt"', "hi") +
    "--" + BOUNDARY + "--\r\n",
    {headers: {"Content-Type": "multipart/form-data; boundary=" + BOUNDARY}});
  var got2 = JSON.parse(r2.body);
  expect(got2.files).toEqual([]);
  expect(got2.fields).toEqual({f: "hi"});

  app.close();
});

test("forms: json and urlencoded limits", async () => {
  var app = concarne();
  app.use(concarne.json({limit: 10}));
  app.use(concarne.urlencoded({limit: "20b"}));
  app.post("/echo", (req, res) => res.json({got: req.body}));
  app.listen(18456);

  var r = await http.post("http://127.0.0.1:18456/echo", '{"a":1}',
    {headers: {"Content-Type": "application/json"}});
  expect(r.status).toBe(200);
  expect(JSON.parse(r.body).got).toEqual({a: 1});

  r = await http.post("http://127.0.0.1:18456/echo", '{"abcdef":123456}',
    {headers: {"Content-Type": "application/json"}});
  expect(r.status).toBe(413);
  expect(JSON.parse(r.body).error).toBe("Body too large");

  r = await http.post("http://127.0.0.1:18456/echo", "{nope",
    {headers: {"Content-Type": "application/json"}});
  expect(r.status).toBe(400);

  // Non-JSON bodies skip the json limiter; urlencoded has its own.
  r = await http.post("http://127.0.0.1:18456/echo", "x=1",
    {headers: {"Content-Type": "application/x-www-form-urlencoded"}});
  expect(r.status).toBe(200);
  r = await http.post("http://127.0.0.1:18456/echo", "x=12345678901234567890",
    {headers: {"Content-Type": "application/x-www-form-urlencoded"}});
  expect(r.status).toBe(413);

  expect(function () { concarne.json({limit: "huge"}); }).toThrow();
  expect(function () { concarne.json("100kb"); }).toThrow();

  app.close();
});
