// concarne uploads + cookies example. Run from the package root:
//   carne run examples/upload.js
// Then:
//   curl -F "title=hello" -F "file=@package.json" http://127.0.0.1:3000/upload
//   curl http://127.0.0.1:3000/login -v
const concarne = require("../index.js");

var app = concarne();

app.use(concarne.json({limit: "1mb"}));
app.use(concarne.logger("dev"));

app.post("/upload", (req, res) => {
  var files = req.files.map((f) => ({
    field: f.field,
    filename: f.filename,
    contentType: f.contentType,
    size: f.size
  }));
  res.json({fields: req.body, files: files});
});

app.get("/login", (req, res) => {
  res.cookie("session", "abc", {httpOnly: true, sameSite: "lax"});
  res.json({ok: true});
});

app.get("/me", (req, res) => {
  res.json({session: req.cookies.session || null});
});

var srv = app.listen(3000, (info) => {
  console.log("upload on http://" + info.host + ":" + info.port);
});
