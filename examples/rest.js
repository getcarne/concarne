// concarne REST example. Run: carne run examples/rest.js
// Then:
//   curl http://127.0.0.1:3000/users/42
//   curl -X POST http://127.0.0.1:3000/users -H 'content-type: application/json' -d '{"name":"ada"}'
const concarne = require("../index.js");

var app = concarne();
var nextId = 3;
var users = {1: "ada", 2: "grace"};

app.get("/users/:id", (req, res) => {
  var name = users[req.params.id];
  if (name === undefined) throw concarne.HttpError(404, "no such user");
  res.json({id: req.params.id, name: name});
});

app.post("/users", (req, res) => {
  var name = req.body.name;
  if (typeof name !== "string" || name === "") {
    throw concarne.HttpError(422, "name is required");
  }
  var id = String(nextId++);
  users[id] = name;
  res.status(201).json({id: id, name: name});
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({error: err.message});
});

var srv = app.listen(3000, (info) => {
  console.log("rest on http://" + info.host + ":" + info.port);
});
