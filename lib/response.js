// concarne response: collects status/headers/body, maps onto the
// runtime's {status, headers, body} handler return (or the {headers,
// file[, attachment][, stream]} file shape for zero-copy sends). All
// mutators are chainable. Sending twice is a no-op (first send wins). Bodies may be
// strings or Uint8Arrays: binary passes through std/http untouched
// (Content-Type defaults to application/octet-stream), strings keep
// the text defaults. Cookies queue per call and merge into repeated
// Set-Cookie headers at toRuntime (the bridge sends string arrays as
// repeated headers).

const os = require("std/os");
const mimetype = require("std/mimetype");

/**
 * Charset suffix for a bare MIME type: text/* is always UTF-8 here,
 * extended to the structured-syntax families concarne has always sent
 * as UTF-8. std/mimetype exposes no charset getter yet, so this lives
 * with us. (File serving uses the runtime's bare MIME table instead.)
 * @param {string} type bare MIME type, e.g. `"text/html"`
 * @returns {string} `"; charset=utf-8"` or `""`
 */
function charsetFor(type) {
  if (type.slice(0, 5) === "text/") return "; charset=utf-8";
  if (type === "application/json" || type.slice(-5) === "+json") {
    return "; charset=utf-8";
  }
  if (type === "application/xml" || type.slice(-4) === "+xml") {
    return "; charset=utf-8";
  }
  if (type === "application/javascript") return "; charset=utf-8";
  return "";
}

/**
 * Memoized `typeFor` results by short name. `mimetype.lookup` crosses
 * the JS/Nim bridge on every call, so the first `res.send`/`res.type`
 * warms the entry and the rest of the process serves it from JS.
 * Entries never expire: the MIME table is process-global and fixed.
 * @type {Object<string, string>}
 */
var typeCache = {};

/**
 * Maps a res.type() short name to a full Content-Type header value via
 * std/mimetype, the single source of truth (sendFile resolves through
 * the same table, so both paths agree). Unknown names pass through
 * untouched, exactly like a full type with a slash does. Results are
 * memoized, so only the first lookup per name crosses the bridge.
 * @param {string} short short name, e.g. `"html"`, `"json"`, `"text"`
 * @returns {string} header value, e.g. `"text/html; charset=utf-8"`
 */
function typeFor(short) {
  var hit = typeCache[short];
  if (hit !== undefined) return hit;
  var found = mimetype.lookup(short);
  var out = (found === null || found === undefined || found === "") ?
    short : found + charsetFor(found);
  typeCache[short] = out;
  return out;
}

var STATUS_TEXTS = {
  200: "OK",
  201: "Created",
  204: "No Content",
  301: "Moved Permanently",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
  501: "Not Implemented",
  503: "Service Unavailable"
};

/**
 * Appends a value to a multi-value response header (`Link`, `Vary`),
 * reading the canonical and lowercase spellings but always writing
 * the canonical one. Values already present are not duplicated.
 * @param {object} res the concarne response
 * @param {string} name the canonical header name (`"Link"`, `"Vary"`)
 * @param {string} value the value to ensure
 * @returns {undefined}
 */
function appendHeader(res, name, value) {
  var cur = res.headers[name];
  if (cur === undefined) cur = res.headers[name.toLowerCase()];
  if (cur === undefined || cur === "") {
    res.headers[name] = value;
    return;
  }
  var parts = String(cur).split(",");
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].replace(/^\s+|\s+$/g, "") === value) return;
  }
  res.headers[name] = String(cur) + ", " + value;
}

var COOKIE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Serializes one `Set-Cookie` value. The value is percent-encoded;
 * `Path` defaults to `"/"`. `sameSite: true` means `Strict`;
 * `"none"` (any case) gains `Secure` when the caller did not set it,
 * per the spec.
 * @param {string} name the cookie name (token chars only)
 * @param {*} value the cookie value (stringified, `null` reads `""`)
 * @param {object} [opts] `{maxAge?, expires?, domain?, path?,
 *   httpOnly?, secure?, sameSite?}`
 * @returns {string} the header value
 */
function serializeCookie(name, value, opts) {
  if (typeof name !== "string" || !COOKIE_TOKEN.test(name)) {
    throw new Error("res.cookie: name must be a non-empty token");
  }
  opts = opts || {};
  var str = name + "=" +
    encodeURIComponent(value === undefined || value === null ? "" : String(value));
  if (opts.maxAge !== undefined) {
    if (typeof opts.maxAge !== "number" || !(opts.maxAge >= 0)) {
      throw new Error("res.cookie: maxAge must be a number >= 0");
    }
    var age = Math.floor(opts.maxAge);
    str += "; Max-Age=" + age;
    str += "; Expires=" + new Date(Date.now() + age * 1000).toUTCString();
  }
  if (opts.expires !== undefined) {
    if (!(opts.expires instanceof Date) || isNaN(opts.expires.getTime())) {
      throw new Error("res.cookie: expires must be a Date");
    }
    str += "; Expires=" + opts.expires.toUTCString();
  }
  if (opts.domain !== undefined) str += "; Domain=" + String(opts.domain);
  str += "; Path=" + (opts.path === undefined ? "/" : String(opts.path));
  if (opts.httpOnly) str += "; HttpOnly";
  var sameSite = opts.sameSite;
  var needSecure = !!opts.secure;
  if (sameSite !== undefined && sameSite !== false && sameSite !== null) {
    var mode = sameSite === true ? "Strict"
      : String(sameSite).toLowerCase() === "lax" ? "Lax"
      : String(sameSite).toLowerCase() === "strict" ? "Strict"
      : String(sameSite).toLowerCase() === "none" ? "None"
      : null;
    if (mode === null) {
      throw new Error("res.cookie: sameSite must be true, lax, strict or none");
    }
    str += "; SameSite=" + mode;
    if (mode === "None") needSecure = true;
  }
  if (needSecure) str += "; Secure";
  return str;
}

/**
 * Builds a `Content-Disposition` value. ASCII filenames go bare in
 * quotes; anything else falls back to an RFC 5987 `filename*` part so
 * the download keeps its name.
 * @param {string} [filename] the download filename
 * @returns {string} the header value
 */
function contentDisposition(filename) {
  if (filename === undefined || filename === null) return "attachment";
  var base = String(filename).split("/").pop().split("\\").pop();
  if (base === "") return "attachment";
  if (/^[\x20-\x7E]+$/.test(base) &&
      base.indexOf("\"") < 0 && base.indexOf(";") < 0) {
    return "attachment; filename=\"" + base + "\"";
  }
  return "attachment; filename=\"download\"; filename*=UTF-8''" +
    encodeURIComponent(base);
}
/**
 * Starts a fresh response: status 200, no headers, nothing sent. Every
 * mutator returns `this` for chaining, and sending twice is a no-op
 * (first send wins). `req` is wired by the dispatcher (undefined
 * for standalone responses) so `format`/`location("back")` can read
 * the request. Methods live on the prototype, so requests allocate
 * one small object instead of a closure per method.
 * @returns {object} the concarne response
 */
function createResponse() {
  return new ConcarneResponse();
}

/**
 * Response constructor: per-request state only. See `createResponse`.
 */
function ConcarneResponse() {
  this.statusCode = 200;
  this.headers = {};
  this.body = "";
  this.sent = false;
  /**
   * Zero-copy file path for `sendFile`/`streamFile`, answered from
   * disk by the runtime (no body buffering, no JS heap copy).
   * @type {string|undefined}
   */
  this.file = undefined;
  /**
   * Attachment marker for file responses: `true` uses the file's
   * basename, a string names the download. `toRuntime` strips any
   * `Content-Disposition` header when set, so the runtime emits
   * exactly one (bare `attachment()` on non-file bodies keeps its
   * header, which answers directly).
   * @type {boolean|string|undefined}
   */
  this._attach = undefined;
  /**
   * Media-streaming marker for `streamFile`: `true` for 1 MB
   * chunks, a number for that chunk size.
   * @type {boolean|number|undefined}
   */
  this._stream = undefined;
  /**
   * Queued `Set-Cookie` values, one per `cookie()` call. Merged
   * into the headers (as one string or an array, which the runtime
   * sends as repeated headers) by `toRuntime`, so any number of
   * cookies survive the single-key headers object.
   * @type {string[]}
   */
  this._cookies = [];
}

/**
 * Sets the response status.
 * @param {number} code HTTP status code
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.status = function (code) {
  this.statusCode = code;
  return this;
};

/**
 * Sets response headers, one field or a whole object. Values are
 * stringified; header names are kept as written.
 * @param {string|object} field name, or `{name: value}` pairs
 * @param {string} [value] the value, when setting one field
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.set = function (field, value) {
  if (typeof field === "object" && field !== null) {
    for (var k in field) {
      if (Object.prototype.hasOwnProperty.call(field, k)) {
        this.headers[k] = String(field[k]);
      }
    }
  } else {
    this.headers[field] = String(value);
  }
  return this;
};

/**
 * Reads a response header exactly as `set` stored it.
 * @param {string} field the header name
 * @returns {string|undefined} the value, or nothing when unset
 */
ConcarneResponse.prototype.get = function (field) {
  return this.headers[field];
};

/**
 * Sets Content-Type by short name (`"html"`, `"json"`, `"text"`,
 * `"css"`, `"js"`, `"xml"`, anything std/mimetype knows) or passes
 * a full type with a slash through untouched.
 * @param {string} t short name or full content type
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.type = function (t) {
  if (t.indexOf("/") >= 0) {
    return this.set("Content-Type", t);
  }
  return this.set("Content-Type", typeFor(t));
};

/**
 * Answers JSON: sets the content type, stringifies the value
 * (`undefined` answers `"null"` so the body is always a string).
 * @param {*} obj the value to send
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.json = function (obj) {
  if (this.sent) return this;
  this.set("Content-Type", typeFor("json"));
  var text = JSON.stringify(obj);
  this.body = text === undefined ? "null" : text;
  this.sent = true;
  return this;
};
/**
 * Answers with anything: a number sets the status and the standard
 * reason body, an object goes out as JSON, a Uint8Array as binary,
 * anything else as text (HTML content type unless already set).
 * @param {*} payload the body, or a status code
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.send = function (payload) {
  if (this.sent) return this;
  if (typeof payload === "number") {
    this.statusCode = payload;
    this.set("Content-Type", typeFor("text"));
    this.body = STATUS_TEXTS[payload] || "";
    this.sent = true;
    return this;
  }
  if (typeof payload === "object" && payload !== null) {
    if (payload instanceof Uint8Array) {
      this.body = payload;
      this.sent = true;
      return this;
    }
    return this.json(payload);
  }
  if (this.headers["Content-Type"] === undefined) {
    this.set("Content-Type", typeFor("html"));
  }
  this.body = payload === undefined ? "" : String(payload);
  this.sent = true;
  return this;
};

/**
 * Ends the response with a raw body: strings as-is, Uint8Array as
 * binary, `undefined` as empty (for status-only answers like 204).
 * @param {string|Uint8Array} [payload] the body
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.end = function (payload) {
  if (this.sent) return this;
  if (payload === undefined) {
    this.body = "";
  } else if (payload instanceof Uint8Array) {
    this.body = payload;
  } else {
    this.body = String(payload);
  }
  this.sent = true;
  return this;
};
/**
 * Answers a single file zero-copy: the runtime sends it from disk
 * via sendfile (no body buffering, no JS heap copy) with a bare
 * MIME type, `Accept-Ranges`, an auto ETag/Last-Modified, and
 * automatic `Range` (206/`Content-Range`/416), `If-None-Match` and
 * `If-Modified-Since` (304) handling. `HEAD` answers the same
 * headers with an empty body. Missing files answer 404 JSON,
 * like before; anything the runtime already sent stays sent.
 * Extra headers set beforehand (e.g. `Cache-Control`) pass
 * through, except the names the runtime owns (`Content-Type`,
 * `Content-Length`, `Content-Range`, `Connection`, `Date`).
 * @param {string} path the file path
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.sendFile = function (path) {
  if (this.sent) return this;
  var isFile = false;
  try {
    isFile = os.isFile(path);
  } catch (e) {
    isFile = false;
  }
  if (!isFile) {
    return this.status(404).json({error: "Not Found"});
  }
  this.file = path;
  this.sent = true;
  return this;
};

/**
 * Redirects with a Location header and a short text body naming
 * the target. `"back"` reads the `Referrer` header (`"/"` when
 * the dispatcher did not wire a request or none was sent).
 * @param {string} url where to go, or `"back"`
 * @param {number} [code] redirect status (default 302)
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.redirect = function (url, code) {
  if (this.sent) return this;
  if (url === "back") {
    url = (this.req && typeof this.req.get === "function" &&
      (this.req.get("referrer") || this.req.get("referer"))) || "/";
  }
  this.statusCode = code || 302;
  this.set("Location", url);
  this.set("Content-Type", typeFor("text"));
  this.body = (STATUS_TEXTS[this.statusCode] || "Redirect") + ": " + url;
  this.sent = true;
  return this;
};

/**
 * Queues a `Set-Cookie` header. Every call appends (never
 * overwrites), so several cookies go out as repeated headers;
 * values are percent-encoded, `Path` defaults to `"/"`.
 * @param {string} name the cookie name (token chars only)
 * @param {*} value the cookie value (stringified)
 * @param {object} [opts] `{maxAge?, expires?, domain?, path?,
 *   httpOnly?, secure?, sameSite?}` (`sameSite: true` reads
 *   `Strict`; `"none"` gains `Secure` automatically)
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.cookie = function (name, value, opts) {
  this._cookies.push(serializeCookie(name, value, opts));
  return this;
};

/**
 * Queues an expired `Set-Cookie` that clears the cookie. `path`
 * (and `domain`) must match the original cookie or browsers keep
 * it; pass the same opts you set it with.
 * @param {string} name the cookie name
 * @param {object} [opts] `{path?, domain?}` of the original cookie
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.clearCookie = function (name, opts) {
  opts = opts || {};
  var merged = {};
  for (var k in opts) {
    if (Object.prototype.hasOwnProperty.call(opts, k)) merged[k] = opts[k];
  }
  merged.expires = new Date(1);
  this._cookies.push(serializeCookie(name, "", merged));
  return this;
};
/**
 * Sets the `Location` header without responding, for pairing with
 * an explicit status (`res.status(201).location("/x").end()`).
 * `"back"` reads the `Referrer` header (`"/"` fallback).
 * @param {string} url where to point, or `"back"`
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.location = function (url) {
  if (url === "back") {
    url = (this.req && typeof this.req.get === "function" &&
      (this.req.get("referrer") || this.req.get("referer"))) || "/";
  }
  this.set("Location", url);
  return this;
};

/**
 * Merges `Link` response headers (`<url>; rel="name"` pairs
 * joined with `", "`), appending to any previous `links` call.
 * @param {object} obj `{rel: url}` pairs
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.links = function (obj) {
  for (var rel in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, rel)) {
      appendHeader(this, "Link", "<" + obj[rel] + ">; rel=\"" + rel + "\"");
    }
  }
  return this;
};

/**
 * Ensures response header fields vary (`Vary`), appending without
 * duplicating. `"*"` replaces the whole value.
 * @param {string|string[]} field the field name(s)
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.vary = function (field) {
  var fields = Array.isArray(field) ? field : [field];
  for (var i = 0; i < fields.length; i++) {
    if (String(fields[i]) === "*") {
      this.set("Vary", "*");
    } else {
      appendHeader(this, "Vary", String(fields[i]));
    }
  }
  return this;
};

/**
 * Answers just a status: the standard reason phrase as the text
 * body (`""` for unknown codes).
 * @param {number} code HTTP status code
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.sendStatus = function (code) {
  return this.send(code);
};

/**
 * Marks the response as a file download (`Content-Disposition:
 * attachment`) without sending yet; pair with `sendFile`
 * (`res.attachment("a.zip").sendFile(path)`), or answer a buffer
 * directly. With no filename answers bare `attachment`. On file
 * responses the runtime emits the disposition (exactly one);
 * buffer bodies keep the header set here.
 * @param {string} [filename] the download filename
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.attachment = function (filename) {
  this._attach = filename === undefined ? true : String(filename);
  this.set("Content-Disposition", contentDisposition(filename));
  return this;
};

/**
 * Answers a file as a download: `Content-Disposition: attachment`
 * (custom filename or the file's basename) plus zero-copy
 * `sendFile` serving with `Range`/conditional support. Missing
 * files answer 404 JSON like `sendFile` does.
 * @param {string} path the file path
 * @param {string} [filename] the download filename (defaults to
 *   the file's own name)
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.download = function (path, filename) {
  if (this.sent) return this;
  if (filename === undefined) {
    this._attach = true;
  } else {
    var base = String(filename).split("/").pop().split("\\").pop();
    this._attach = base === "" ? true : base;
  }
  return this.sendFile(path);
};

/**
 * Streams a file for media playback zero-copy: the first response
 * is 206 with one chunk (default 1 MB, so seeking transfers a
 * chunk, not the whole file), later `Range` requests stream their
 * capped slices, always keep-alive. Missing files answer 404 JSON.
 * @param {string} path the file path
 * @param {number} [chunkSize] max bytes per response (> 0)
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.streamFile = function (path, chunkSize) {
  if (this.sent) return this;
  if (chunkSize !== undefined &&
      (typeof chunkSize !== "number" || !(chunkSize > 0))) {
    throw new Error("res.streamFile: chunkSize must be a number > 0");
  }
  var isFile = false;
  try {
    isFile = os.isFile(path);
  } catch (e) {
    isFile = false;
  }
  if (!isFile) {
    return this.status(404).json({error: "Not Found"});
  }
  this.file = path;
  this._stream = chunkSize === undefined ? true : Math.floor(chunkSize);
  this.sent = true;
  return this;
};
/**
 * Answers by content negotiation: picks the first key of `obj`
 * the request's `Accept` header allows (via `req.accepts`) and
 * runs its handler. A `default` key runs when nothing matches (or
 * when the dispatcher did not wire a request); otherwise answers
 * 406 JSON. Keys are short names or MIME types, exactly as
 * `req.accepts` takes them.
 * @param {object} obj `{type: handler}` pairs plus optional
 *   `default`
 * @returns {object} this, for chaining
 */
ConcarneResponse.prototype.format = function (obj) {
  if (this.sent) return this;
  var keys = Object.keys(obj).filter(function (k) { return k !== "default"; });
  var match = false;
  if (this.req && typeof this.req.accepts === "function" && keys.length > 0) {
    match = this.req.accepts(keys);
  } else if (keys.length > 0) {
    match = keys[0];
  }
  if (match !== false && typeof obj[match] === "function") {
    obj[match]();
    return this;
  }
  if (typeof obj.default === "function") {
    obj.default();
    return this;
  }
  this.status(406).json({error: "Not Acceptable"});
  return this;
};

/**
 * Freezes the response into the runtime's shape: `{status,
 * headers, body}` normally, or `{headers, file[, attachment][,
 * stream]}` for `sendFile`/`streamFile` (file mode owns the
 * status: 200/206/304/404/416 come from the file serving itself).
 * Binary bodies without a content type default to
 * application/octet-stream; anything else becomes a string.
 * Queued cookies (`cookie()` plus any `set("Set-Cookie", ...)`
 * values, both spellings) merge into one `Set-Cookie` string or
 * an array the runtime sends as repeated headers. In file mode an
 * `_attach` marker strips any `Content-Disposition` header, so the
 * runtime emits exactly one.
 * @returns {{status: number, headers: object, body: *}} the
 *   runtime response (or the `{headers, file, ...}` file shape)
 */
ConcarneResponse.prototype.toRuntime = function () {
  if (this.file !== undefined) {
    if (this._attach !== undefined) {
      delete this.headers["Content-Disposition"];
      delete this.headers["content-disposition"];
    }
    var out = {headers: this.headers, file: this.file};
    if (this._attach !== undefined) out.attachment = this._attach;
    if (this._stream !== undefined) out.stream = this._stream;
    return out;
  }
  var body = this.body;
  if (typeof body !== "string" && !(body instanceof Uint8Array)) {
    body = String(body);
  }
  if (body instanceof Uint8Array &&
      this.headers["Content-Type"] === undefined) {
    this.headers["Content-Type"] = "application/octet-stream";
  }
  var cookies = this._cookies.length === 0 ? null :
    this._cookies.slice();
  for (var ci = 0; ci < 2; ci++) {
    var ckey = ci === 0 ? "Set-Cookie" : "set-cookie";
    if (this.headers[ckey] !== undefined) {
      if (cookies === null) cookies = [];
      cookies.push(this.headers[ckey]);
      delete this.headers[ckey];
    }
  }
  if (cookies !== null) {
    if (cookies.length === 1) {
      this.headers["Set-Cookie"] = cookies[0];
    } else if (cookies.length > 1) {
      this.headers["Set-Cookie"] = cookies;
    }
  }
  return {
    status: this.statusCode,
    headers: this.headers,
    body: body === undefined ? "" : body
  };
};

module.exports = {
  createResponse: createResponse,
  STATUS_TEXTS: STATUS_TEXTS
};
