// concarne hello example. Run: carne run examples/hello.js
// Then: curl http://127.0.0.1:3000/hi/ada
const concarne = require("../index.js");

var app = concarne();

app.use((req, res, next) => {
  // console.log(req.method + " " + req.url);
  next();
});

app.get("/", (req, res) => res.send("hello"))

app.get("/hi/:name", (req, res) => res.send("hi " + req.params.name));

var srv = app.listen(3000, (info) => {
  console.log("hello on http://" + info.host + ":" + info.port);
});
