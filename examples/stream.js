// concarne streaming example, adapted from powpow's
// examples/stream_server.nim. Run from the package root:
//   carne run examples/stream.js
// Then open http://127.0.0.1:3000/ in a browser, or:
//   curl -r 0-99 http://127.0.0.1:3000/video -o /dev/null -D -
//   curl -O -J http://127.0.0.1:3000/download
//
// Needs examples/data/Big_Buck_Bunny_4K.webm (gitignored, ~3 GB from
// https://en.wikipedia.org/wiki/File:Big_Buck_Bunny_4K.webm).
// Everything below is zero-copy: bytes go out via sendfile, never
// through the JS heap.
const concarne = require("../index.js");

var VIDEO = "examples/data/Big_Buck_Bunny_4K.webm";

var app = concarne();

app.get("/", (req, res) => res.type("html").send(
  `<!doctype html><video controls width="640" src="/video"></video><p><a href="/download">download</a> <a href="/resume">resume</a></p>`
));

// Media streaming with chunk limiting (1 MB per response),
// always keep-alive, always handles Range requests.
app.get("/video", (req, res) => res.streamFile(VIDEO));

// File download with Content-Disposition: attachment and
// Range support (seekable, resumable).
app.get("/download", (req, res) => res.download(VIDEO));

// Inline serving with resume support: ETag/Last-Modified,
// If-None-Match and If-Modified-Since answer 304, Range answers 206
// with Content-Range (If-Range revalidates first).
app.get("/resume", (req, res) => res.sendFile(VIDEO));

var srv = app.listen(3000, (info) => {
  console.log("stream on http://" + info.host + ":" + info.port);
});
