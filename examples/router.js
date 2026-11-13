// concarne Router example. Run from the package root:
//   carne run examples/router.js
// Then:
//   curl http://127.0.0.1:3000/api/users/42
//   curl http://127.0.0.1:3000/api/users/abc
//   curl -X PUT http://127.0.0.1:3000/api/users/42 -v
const concarne = require("../index.js");
const Router = concarne.Router;

var app = concarne();

var api = Router();
api.param("id", (req, res, next, value) => {
  if (!/^[0-9]+$/.test(value)) {
    next(concarne.HttpError(400, "bad id"));
    return;
  }
  next();
});
api.get("/users/:id", (req, res) => {
  res.json({id: req.params.id, base: req.baseUrl});
});
api.route("/users")
  .get((req, res) => res.json({users: []}))
  .post((req, res) => res.status(201).json({made: req.body}));
app.use("/api", api);

app.get("/hi", (req, res) => res.send("hi"));

var srv = app.listen(3000, (info) => {
  console.log("router on http://" + info.host + ":" + info.port);
});
