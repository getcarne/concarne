// Errors: throws, next(err), error middleware, err.status, recovery.
const http = require("std/http");
const concarne = require("../index.js");
const HttpError = require("../index.js").HttpError;
const check = require("./helper.js").check;

async function run() {
  var app = concarne();
  app.get("/boom", (req, res) => { throw new Error("kaput"); });
  app.get("/denied", (req, res) => { throw HttpError(403, "no entry"); });
  app.get("/routed-err", (req, res, next) => next(HttpError(422, "bad shape")));
  app.get("/recovered", (req, res, next) => next(new Error("handled")),
    (req, res) => res.send("unreached"));
  app.use((err, req, res, next) => {
    if (err.message === "handled") {
      res.send("caught:" + err.message);
    } else {
      next(err);
    }
  });
  app.use((err, req, res, next) => {
    res.status(err.status || 500).json({error: err.message});
  });
  app.listen(18404);

  var r = await http.get("http://127.0.0.1:18404/boom");
  check(r.status === 500, "throw becomes a 500");
  check(JSON.parse(r.body).error === "kaput", "error middleware sees the throw");

  r = await http.get("http://127.0.0.1:18404/denied");
  check(r.status === 403, "err.status is honored");
  check(JSON.parse(r.body).error === "no entry", "HttpError message passes through");

  r = await http.get("http://127.0.0.1:18404/routed-err");
  check(r.status === 422, "next(err) skips to error middleware");

  r = await http.get("http://127.0.0.1:18404/recovered");
  check(r.status === 200 && r.body === "caught:handled", "error middleware can answer");

  // No error middleware at all: defaults still hold.
  var bare = concarne();
  bare.get("/x", (req, res) => { throw new Error("raw"); });
  bare.listen(18405);
  r = await http.get("http://127.0.0.1:18405/x");
  check(r.status === 500 && JSON.parse(r.body).error === "raw", "default 500 JSON without middleware");
  bare.close();

  app.close();
}

module.exports = {run: run};
