// concarne CORS + rate limit example. Run from the package root:
//   carne run examples/middleware.js
// Then: curl http://127.0.0.1:3000/api/hi -H "Origin: https://app.example.com" -v
const concarne = require("../index.js");

var app = concarne();

// Open API, capped at 100 requests per minute per client IP.
app.use("/api", concarne.cors());
app.use("/api", concarne.rateLimit({windowMs: 60000, limit: 100}));

// Admin surface: only the dashboard origin, cookies allowed.
app.use("/admin", concarne.cors({
  origin: "https://admin.example.com",
  credentials: true
}));

app.get("/api/hi", (req, res) => res.json({hi: true, ip: req.ip}));
app.get("/admin/hi", (req, res) => res.json({admin: true}));

var srv = app.listen(3000, (info) => {
  console.log("middleware on http://" + info.host + ":" + info.port);
});
