// Errors: throws, next(err), error middleware, err.status, recovery.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");
const HttpError = require("../index.js").HttpError;

test("errors: throws, next(err), err.status, recovery, defaults", async () => {
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
  expect(r.status).toBe(500);
  expect(JSON.parse(r.body).error).toBe("kaput");

  r = await http.get("http://127.0.0.1:18404/denied");
  expect(r.status).toBe(403);
  expect(JSON.parse(r.body).error).toBe("no entry");

  r = await http.get("http://127.0.0.1:18404/routed-err");
  expect(r.status).toBe(422);

  r = await http.get("http://127.0.0.1:18404/recovered");
  expect(r.status).toBe(200);
  expect(r.body).toBe("caught:handled");

  // No error middleware at all: defaults still hold.
  var bare = concarne();
  bare.get("/x", (req, res) => { throw new Error("raw"); });
  bare.listen(18405);
  r = await http.get("http://127.0.0.1:18405/x");
  expect(r.status).toBe(500);
  expect(JSON.parse(r.body).error).toBe("raw");
  bare.close();

  app.close();
});
