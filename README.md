<p align="center">
  <img src="https://github.com/openpeeps/carne/blob/main/.github/carne_logo.png" alt="Carne Logo" width="140px" height="140px"><br>
  <strong>ConCarne</strong>, an Express-like web framework for <a href="https://github.com/openpeeps/carne">Carne</a><br>
  Routing, middleware and JSON APIs in pure JS on top of <code>std/http</code>.
</p>

## Install

```bash
carne pkg install concarne
```

Or link a checkout while developing:

```bash
carne pkg develop /path/to/concarne
```

## Usage

```js
const concarne = require("pkg/concarne");
const app = concarne();

app.use((req, res, next) => {
  console.log(req.method + " " + req.url);
  next();
});

app.get("/users/:id", (req, res) => res.json({id: req.params.id}));
app.post("/users", (req, res) => res.status(201).json({id: "3"}));

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({error: err.message});
});

app.listen(3000);
```

## Features

- Express-style routing: `:params`, `*` wildcards, mountable routers
- Middleware with path prefixes and 4-arg error handlers
- JSON, urlencoded and multipart bodies with size limits
- Cookies in and out, with expiry and `SameSite` support
- Content negotiation, redirects, downloads and status helpers
- Zero-copy static files and media streaming with ETag/Range support
- CORS, rate limiting, helmet, logger and request IDs in core
- Single or multi-worker serving off one port
- Sync handlers, CommonJS, pure JS on `std/http`

## Routers

`concarne.Router()` builds a mountable sub-app with the same API
(`use`, verbs, `route`, `param`). Mounted with `app.use("/api",
router)`, it sees the stripped path (`req.path` is `"/profile"` for
`/api/profile`) while `req.baseUrl` accumulates the mount
(`"/api"`, `"/api/deep"` when nested) and `req.originalUrl` keeps the
full URL. A miss inside the router falls through to the outer app;
routers nest.

```js
const Router = concarne.Router;
const api = Router();
api.get("/users/:id", (req, res) => res.json({id: req.params.id}));
app.use("/api", api);
```

`app.route("/users").get(list).post(create)` chains verbs on one path.
`app.param("id", (req, res, next, value, name) => {...})` runs when a
matched route carries that `:name`: coerce it, or `next(err)` / throw
to reject (it runs once per name+value per request, and applies to
routes on the same app or router it was registered on).

`app.head`/`app.options` register those verbs; `GET` routes also
answer `HEAD` (the runtime strips the body). A known path with the
wrong method answers `405 {error: "Method Not Allowed"}` with an
`Allow` header instead of falling through to 404; `OPTIONS` to a
known path auto-answers `200` with `Allow` (an explicit
`app.options(path)` route still wins).

## CORS

`concarne.cors([opts])` is middleware in the express `cors` shape.
Requests without an Origin header pass through untouched; preflights
end here with `optionsSuccessStatus` (default 204) unless
`preflightContinue` is set.

```
app.use(concarne.cors());
app.use(concarne.cors({origin: "https://app.example.com", credentials: true}));
app.use("/api", concarne.cors({origin: ["https://a.example.com"]}));
```

`origin` takes `"*"` (default), an exact string, an array of exact
strings, `true` to reflect the request origin, or
`function (origin)` returning `true`, an allowed string, or a falsy
value to deny. With `credentials: true` a wildcard reflects instead of
answering `*`, per the spec. Other opts: `methods` (default
`"GET,HEAD,PUT,PATCH,POST,DELETE"`), `allowedHeaders` (default: reflect
the request's), `exposedHeaders`, `maxAge` (seconds),
`optionsSuccessStatus`, `preflightContinue`.

## Rate limit

`concarne.rateLimit([opts])` caps requests per key in a fixed window.
Counters live in memory, so each worker under `workers > 1` counts on
its own: set limits conservatively when serving multi-worker.

```
app.use(concarne.rateLimit({windowMs: 60000, limit: 100}));
```

Defaults: `windowMs: 60000`, `limit: 100` (`max` is accepted as an
alias), key `req.ip`, 429 `"Too many requests"`. Every answer carries
`RateLimit-Limit/Remaining/Reset`, and 429s add `Retry-After`. Tune
with `key(req)`, `message` (string or object), `statusCode`,
`headers: false`, `skip(req)`, and `onLimit(req, res)` for a custom
429 responder. The middleware also carries `.reset(key)` and `.clear()`
helpers. Bad options throw at factory time, not per request.

## Middleware pack

In core, no extra packages:

```js
app.use(concarne.logger("dev"));    // morgan-style: dev | tiny | combined
app.use(concarne.helmet());         // security headers, app-set wins
app.use(concarne.requestId());      // req.id + X-Request-Id echo
```

`logger("dev")` prints `METHOD url STATUS ms - length` with
TTY-gated colors (`"tiny"` is plainer, `"combined"` Apache-style).
`helmet()` sends `X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN`, `X-DNS-Prefetch-Control: off`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy:
same-origin` and `Origin-Agent-Cluster: ?1` unless the app already
set them; any opt takes a string override or `false` to skip.
`requestId([{header, generate}])` trusts an incoming id (default
header `X-Request-Id`), otherwise mints a uuid v4, sets `req.id` and
echoes it back; pass `generate` for custom ids.

## Bodies

JSON and urlencoded bodies parse automatically (`req.body`; repeated
keys become arrays). `concarne.json([{limit}])` and
`concarne.urlencoded([{limit}])` add size caps (default `"100kb"`,
bytes or `"Nkb"/"Nmb"/"Ngb"`) with `413 Body too large` past them,
and fail invalid JSON 400 up front:

```js
app.use(concarne.json({limit: "1mb"}));
app.use(concarne.urlencoded());
```

`multipart/form-data` streams to tmpfiles from the first body byte
(powpow owns the parsing: per-file/per-field/total caps from the
serve `maxBodySize` opt, binary-safe throughout). Text fields land in
`req.body` (repeated names become arrays); `req.files` lists
`{field, filename, contentType, size, path, data}` with `data` a
binary-safe `Uint8Array` read eagerly. Tmpfiles are deleted right
after the handler returns, so consume uploads during handling. File
parts need a filename and a `Content-Type` header (what curl and
browsers send; a filename-only part reads as a text field).

## Cookies

```js
app.get("/login", (req, res) => {
  res.cookie("session", "abc", {httpOnly: true, maxAge: 3600, sameSite: "lax"});
  res.json({ok: true});
});
app.get("/logout", (req, res) => {
  res.clearCookie("session", {path: "/"});
  res.json({ok: true});
});
```

Every `cookie()` call appends a `Set-Cookie` header (values
percent-encoded, `Path` defaulting to `"/"`); `sameSite: true` reads
`Strict`, `"none"` gains `Secure` automatically. `clearCookie(name[,
opts])` expires the cookie; match the original `path`/`domain` or
browsers keep it. `req.cookies` parses the request side.

## Content negotiation

```js
app.get("/report", (req, res) => res.format({
  html: () => res.send("<h1>hi</h1>"),
  json: () => res.json({hi: true}),
  default: () => res.sendStatus(406)
}));
```

`req.accepts(...types)` (short names or MIME types, arrays flatten)
answers the first offered type the `Accept` header allows (`false`
when none; no header reads as `*/*`); `res.format(obj)` runs the
matching handler, a `default` handler when nothing matches, or 406
JSON. `res.vary("Accept")` and `res.links({next: "/p2"})` set the
companion headers; `res.location(url)` (or `"back"`) sets `Location`
without responding; `res.sendStatus(code)` answers just the status;
`res.download(path[, filename])` / `res.attachment([filename])` serve
downloads.

## Settings

```js
app.enable("trust proxy");
app.get("trust proxy"); // true
```

`app.set(name[, value])` / `app.get(name)` / `app.enable(name)` /
`app.disable(name)` / `app.enabled(name)` / `app.disabled(name)` own
a settings bag; single-argument `app.get(name)` reads (routing still
takes two or more arguments). `"trust proxy"` (default off) is
honored: `req.ip` reads the leftmost `X-Forwarded-For` entry,
`req.hostname` prefers `X-Forwarded-Host`, `req.protocol` follows
`X-Forwarded-Proto` (`req.secure` is `protocol === "https"`).
`req.xhr` flags `X-Requested-With: XMLHttpRequest` either way.

## Static files

`concarne.static(root[, opts])` serves a directory tree as
middleware, zero-copy: bytes go out via sendfile, never buffered in
the JS heap. Only `GET`/`HEAD` run; anything else (and any miss)
calls `next()`, so the app's own routes and 404 own the request.
Ranges, conditional revalidation and `HEAD` come from the file
serving itself (see below); symlinks are followed and dotfiles answer
like misses.

```js
app.use(concarne.static("./public", {maxAge: 3600}));
app.use("/assets", concarne.static("./public", {strip: "/assets"}));
```

Options: `index` (default `"index.html"`, `null` disables directory
indexes), `maxAge` (seconds for `Cache-Control`, default `0`),
`strip` (prefix to remove before mapping, for mounted middleware).
Directories without a trailing slash redirect (`301`) to the slash
form; traversal outside the root is always a miss.

`res.sendFile(path)` answers a single file (404 JSON when missing),
and `res.send`/`res.end` also accept `Uint8Array` bodies
(`Content-Type` defaults to `application/octet-stream`).

## Zero-copy file serving

`res.sendFile(path)`, `res.download(path[, filename])` and the
static middleware answer from disk via sendfile: the file is never
read into the JS heap, so multi-gigabyte responses cost ~nothing in
memory. `res.streamFile(path[, chunkSize])` streams media the same
way, answering 206 with one chunk per response (default 1 MB, so
seeking transfers a slice, not the file).

ETag and range support come free with every file answer, no
middleware needed:

- `ETag` (`"size-mtime"`) and `Last-Modified` ride every 200;
  `If-None-Match`/`If-Modified-Since` answer `304` with empty bodies.
- `Range` answers `206` with `Content-Range` and `Accept-Ranges:
  bytes`; unsatisfiable ranges answer `416`; `If-Range` revalidates
  before ranging.
- `HEAD` answers the same headers with an empty body (`Content-Length`
  reads `0`, like every `HEAD` response in v1).
- `Content-Type` follows the runtime's bare MIME table (no charset
  suffix, e.g. `text/html` rather than `text/html; charset=utf-8`);
  extra headers set beforehand (e.g. `Cache-Control`) pass through,
  except the names the file serving owns (`Content-Type`,
  `Content-Length`, `Content-Range`, `Connection`, `Date`).


## API

Routes: `app.get/post/put/patch/delete/head/options/all(path,
...handlers)`, plus `app.route(path)` chaining and `app.param(name,
fn)`. Paths take `:params`, `*` wildcards (as `req.params["0"]`,
spanning slashes), and an optional trailing slash. Handler arrays are
flattened, so `app.get(p, [a, b], c)` runs `a`, `b`, `c` in order.
`GET` routes answer `HEAD`; known-path-wrong-method answers 405 with
`Allow`; `OPTIONS` auto-answers 200 with `Allow`.
`concarne.Router()` mounts sub-apps under `app.use(path, router)` with
stripping (`req.path` stripped, `req.baseUrl` accumulated,
`req.originalUrl` intact).

Middleware: `app.use([path, ]...fns)`. Runs in registration order for its
path prefix (`"/api"` matches `/api` and below; `"/"` matches all).
Four-arg functions are error middleware and only run after `next(err)` or
a throw. A layer that neither sends nor calls `next()` answers 500
instead of hanging. Unmatched requests answer `404 {error, path}`;
unhandled errors answer `500 {error}`. In core: `cors`, `rateLimit`,
`logger`, `helmet`, `requestId`, `json`, `urlencoded`, `static`.

`req`: `method`, `path`, `url`, `originalUrl`, `baseUrl`, `headers`,
`params`, `ip`, `hostname`, `protocol`, `secure`, `xhr`, `id`,
plus lazy `query` (repeated keys become arrays, `+` decodes to
space), `body` (parsed JSON with a 400 on invalid input, pairs for
urlencoded, multipart text fields, raw string otherwise), `files`
(multipart uploads), and `cookies`. `req.get(name)` reads a header
case-insensitively; `req.accepts(...types)` negotiates the response
type; `req.rawBody` is the untouched string; `req.res` is the paired
response.

`res` (all chainable): `status(code)`, `set(field, value)` / `set(obj)`,
`get(field)`, `type(name)` (`html`, `json`, `text`, `css`, `js`, `xml`,
anything `std/mimetype` knows, or a full content type),
`send(string|object|number|Uint8Array)`, `json(obj)`,
`sendFile(path)` (zero-copy, ranges/conditionals automatic, bare
MIME), `streamFile(path[, chunkSize])` (206-first media streaming),
`download(path[, filename])` (zero-copy attachment),
`attachment([filename])`, `redirect(url[, code])`,
`location(url)`, `links(obj)`, `vary(field)`, `cookie(name, value[,
opts])`, `clearCookie(name[, opts])`, `sendStatus(code)`,
`format(obj)`, `end([body])`. First send wins; later sends are
ignored. Short names resolve through `std/mimetype`, so `sendFile` and
`type` always agree (`js` answers `application/javascript`, `xml`
answers `text/xml`, each with a UTF-8 charset).
`concarne.HttpError(status, message)` builds errors the default
handler respects. Settings: `app.set/get/enable/disable/enabled/disabled`
(`"trust proxy"` honored for `ip`/`hostname`/`protocol`).

`app.listen(port[, host][, opts][, cb])` returns `{port, host, workers,
close}`; `app.close()` stops the server (`false` when not listening).
Servers hold the event loop until closed, like Node. `opts` passes
through to `std/http`: `{workers?, keepAliveMs?, readTimeoutMs?,
maxBodySize?}`. The default `workers: 1` serves single-threaded;
`workers: N` (2..64) serves from N full runtimes sharing the port.

```js
const app = concarne();
app.get("/hi/:name", (req, res) => res.send("hi " + req.params.name));

// Single: app.listen(3000);
// Multi (see examples/workers.js):
app.listen(3000, {workers: 4});
```

## Limits in v1

## Limits in v1

Sync route handlers only (the runtime expects the response back from the
serve handler). CommonJS only, like every Carne package. Upload tmpfiles
live only for the handler (read them before returning). Multipart file
parts need a filename and a `Content-Type` header. `ws` routes are out:
`std/ws` serves its own port with no HTTP-upgrade path, so realtime
stays outside concarne until the runtime supports upgrades.

With `workers > 1` each worker is an isolated runtime re-running your
script: no shared state, and module-level side effects (counters, caches,
`require` setup) run once per worker. Gate driver code on
`process.isWorker` (`false` on main, `true` on workers): every context
must call `app.listen`, but only main should fetch/assert/close.

```js
const app = concarne();
app.get("/", (req, res) => res.send("hi"));
app.listen(3000, {workers: 4});
if (!process.isWorker) {
  // driver: fetch, test, then app.close()
}
```

## Tests

```bash
carne test                      # full suite, one server at a time
carne run tests/run_workers.js  # multi-worker suite (own process)
```

## License

MIT.
