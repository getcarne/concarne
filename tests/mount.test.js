// Mounts: sub-routers with prefix stripping, nesting, baseUrl,
// app.param() coercion and errors, root-mounted routers.
const { test, expect } = require("std/test");
const http = require("std/http");
const concarne = require("../index.js");
const Router = concarne.Router;
const HttpError = concarne.HttpError;

test("mount: routers, stripping, nesting, baseUrl, param", async () => {
  var app = concarne();
  app.param("id", (req, res, next, value) => {
    if (!/^[0-9]+$/.test(value)) {
      next(HttpError(400, "bad id"));
      return;
    }
    req.params.id = "num:" + value;
    next();
  });

  var inner = Router();
  inner.use((req, res, next) => {
    res.set("X-Inner", "yes");
    next();
  });
  inner.get("/profile", (req, res) =>
    res.json({base: req.baseUrl, path: req.path, original: req.originalUrl}));
  inner.get("/users/:id", (req, res) =>
    res.json({id: req.params.id, base: req.baseUrl}));

  var deep = Router();
  deep.get("/leaf", (req, res) => res.json({base: req.baseUrl, path: req.path}));
  inner.use("/deep", deep);

  app.use("/api", inner);
  app.get("/users/:id", (req, res) => res.json({id: req.params.id}));
  app.get("/top", (req, res) => res.send("top"));
  app.listen(18451);

  var r = await http.get("http://127.0.0.1:18451/api/profile");
  expect(r.status).toBe(200);
  var profile = JSON.parse(r.body);
  expect(profile.base).toBe("/api");
  expect(profile.path).toBe("/profile");
  expect(profile.original).toBe("/api/profile");
  expect(r.headers["x-inner"]).toBe("yes");

  // Params flow through the stripped router; router middleware ran.
  r = await http.get("http://127.0.0.1:18451/api/users/9");
  var u = JSON.parse(r.body);
  expect(u.base).toBe("/api");
  expect(u.id).toBe("9");

  // Nesting accumulates baseUrl.
  r = await http.get("http://127.0.0.1:18451/api/deep/leaf");
  var leaf = JSON.parse(r.body);
  expect(leaf.base).toBe("/api/deep");
  expect(leaf.path).toBe("/leaf");

  // A miss inside the router falls through to the outer 404.
  r = await http.get("http://127.0.0.1:18451/api/nope");
  expect(r.status).toBe(404);

  // The outer app is untouched by stripping.
  r = await http.get("http://127.0.0.1:18451/top");
  expect(r.body).toBe("top");

  // app.param coerces and rejects.
  r = await http.get("http://127.0.0.1:18451/users/42");
  expect(JSON.parse(r.body).id).toBe("num:42");
  r = await http.get("http://127.0.0.1:18451/users/abc");
  expect(r.status).toBe(400);
  expect(JSON.parse(r.body).error).toBe("bad id");

  app.close();

  // A router mounted without a path sees every request.
  var bare = concarne();
  var flat = Router();
  flat.get("/flat", (req, res) =>
    res.json({base: req.baseUrl, path: req.path}));
  bare.use(flat);
  bare.listen(18452);
  r = await http.get("http://127.0.0.1:18452/flat");
  expect(JSON.parse(r.body).base).toBe("");
  expect(JSON.parse(r.body).path).toBe("/flat");
  bare.close();
});
