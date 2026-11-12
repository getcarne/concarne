// concarne workers example. Run: carne run examples/workers.js
// Then: curl http://127.0.0.1:3000/hi/ada (repeat; both runtimes answer).
// With workers > 1 every worker re-runs this file, so driver code must
// be gated on process.isWorker: all contexts listen, only main drives.
const concarne = require("../index.js");

var app = concarne();

app.get("/hi/:name", (req, res) => res.send("hi " + req.params.name));

var srv = app.listen(3000, {workers: 4}, (info) => {
  if (!process.isWorker) {
    console.log("workers on http://" + info.host + ":" + info.port + " x" + info.workers);
  }
});
