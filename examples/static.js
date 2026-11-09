// concarne static example. Run from the package root:
//   carne run examples/static.js
// Then: curl http://127.0.0.1:3000/ http://127.0.0.1:3000/site.css
var env = require("std/env");
var concarne = require("../index.js");

var app = concarne();

app.use(concarne.static(env.cwd() + "/examples/public", {maxAge: 60}));

app.get("/api/hi", (req, res) => res.json({hi: true}));

var srv = app.listen(3000, (info) => {
  console.log("static on http://" + info.host + ":" + info.port);
});
