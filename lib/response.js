// concarne response: collects status/headers/body, maps onto the
// runtime's {status, headers, body} handler return. All mutators are
// chainable. Sending twice is a no-op (first send wins). Bodies may be
// strings or Uint8Arrays: binary passes through std/http untouched
// (Content-Type defaults to application/octet-stream), strings keep
// the text defaults. Cookies queue per call and merge into repeated
// Set-Cookie headers at toRuntime (the bridge sends string arrays as
// repeated headers).

const os = require("std/os");
const mimetype = require("std/mimetype");
const contentTypeFor = require("./contenttype.js").contentTypeFor;

/**
 * Charset suffix for a bare MIME type. Mirrors the rule in
 * contenttype.js (text/* is always UTF-8 here) extended to the
 * structured-syntax families concarne has always sent as UTF-8.
 * std/mimetype exposes no charset getter yet, so this lives with us.
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
 * Maps a res.type() short name to a full Content-Type header value via
 * std/mimetype, the single source of truth (sendFile resolves through
 * the same table, so both paths agree). Unknown names pass through
 * untouched, exactly like a full type with a slash does.
 * @param {string} short short name, e.g. `"html"`, `"json"`, `"text"`
 * @returns {string} header value, e.g. `"text/html; charset=utf-8"`
 */
function typeFor(short) {
  var found = mimetype.lookup(short);
  if (found === null || found === undefined || found === "") return short;
  return found + charsetFor(found);
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
 * mutator returns `res` for chaining, and sending twice is a no-op
 * (first send wins). `res.req` is wired by the dispatcher (undefined
 * for standalone responses) so `format`/`location("back")` can read
 * the request.
 * @returns {object} the concarne response
 */
function createResponse() {
  var res = {
    statusCode: 200,
    headers: {},
    body: "",
    sent: false,
    /**
     * Queued `Set-Cookie` values, one per `cookie()` call. Merged
     * into the headers (as one string or an array, which the runtime
     * sends as repeated headers) by `toRuntime`, so any number of
     * cookies survive the single-key headers object.
     * @type {string[]}
     */
    _cookies: [],
    /**
     * Sets the response status.
     * @param {number} code HTTP status code
     * @returns {object} res, for chaining
     */
    status: function (code) {
      res.statusCode = code;
      return res;
    },
    /**
     * Sets response headers, one field or a whole object. Values are
     * stringified; header names are kept as written.
     * @param {string|object} field name, or `{name: value}` pairs
     * @param {string} [value] the value, when setting one field
     * @returns {object} res, for chaining
     */
    set: function (field, value) {
      if (typeof field === "object" && field !== null) {
        for (var k in field) {
          if (Object.prototype.hasOwnProperty.call(field, k)) {
            res.headers[k] = String(field[k]);
          }
        }
      } else {
        res.headers[field] = String(value);
      }
      return res;
    },
    /**
     * Reads a response header exactly as `set` stored it.
     * @param {string} field the header name
     * @returns {string|undefined} the value, or nothing when unset
     */
    get: function (field) {
      return res.headers[field];
    },
    /**
     * Sets Content-Type by short name (`"html"`, `"json"`, `"text"`,
     * `"css"`, `"js"`, `"xml"`, anything std/mimetype knows) or passes
     * a full type with a slash through untouched.
     * @param {string} t short name or full content type
     * @returns {object} res, for chaining
     */
    type: function (t) {
      if (t.indexOf("/") >= 0) {
        return res.set("Content-Type", t);
      }
      return res.set("Content-Type", typeFor(t));
    },
    /**
     * Answers JSON: sets the content type, stringifies the value
     * (`undefined` answers `"null"` so the body is always a string).
     * @param {*} obj the value to send
     * @returns {object} res, for chaining
     */
    json: function (obj) {
      if (res.sent) return res;
      res.set("Content-Type", typeFor("json"));
      var text = JSON.stringify(obj);
      res.body = text === undefined ? "null" : text;
      res.sent = true;
      return res;
    },
    /**
     * Answers with anything: a number sets the status and the standard
     * reason body, an object goes out as JSON, a Uint8Array as binary,
     * anything else as text (HTML content type unless already set).
     * @param {*} payload the body, or a status code
     * @returns {object} res, for chaining
     */
    send: function (payload) {
      if (res.sent) return res;
      if (typeof payload === "number") {
        res.statusCode = payload;
        res.set("Content-Type", typeFor("text"));
        res.body = STATUS_TEXTS[payload] || "";
        res.sent = true;
        return res;
      }
      if (typeof payload === "object" && payload !== null) {
        if (payload instanceof Uint8Array) {
          res.body = payload;
          res.sent = true;
          return res;
        }
        return res.json(payload);
      }
      if (res.headers["Content-Type"] === undefined) {
        res.set("Content-Type", typeFor("html"));
      }
      res.body = payload === undefined ? "" : String(payload);
      res.sent = true;
      return res;
    },
    /**
     * Ends the response with a raw body: strings as-is, Uint8Array as
     * binary, `undefined` as empty (for status-only answers like 204).
     * @param {string|Uint8Array} [payload] the body
     * @returns {object} res, for chaining
     */
    end: function (payload) {
      if (res.sent) return res;
      if (payload === undefined) {
        res.body = "";
      } else if (payload instanceof Uint8Array) {
        res.body = payload;
      } else {
        res.body = String(payload);
      }
      res.sent = true;
      return res;
    },
    /**
     * Answers a single file as a binary body with the filename's
     * content type. Missing files answer 404 JSON, unreadable ones 500
     * JSON, and symlinks are followed like the static middleware does.
     * @param {string} path the file path
     * @returns {object} res, for chaining
     */
    sendFile: function (path) {
      if (res.sent) return res;
      var isFile = false;
      try {
        isFile = os.isFile(path);
      } catch (e) {
        isFile = false;
      }
      if (!isFile) {
        return res.status(404).json({error: "Not Found"});
      }
      var data;
      try {
        data = os.readFileBytes(path);
      } catch (e) {
        return res.status(500).json({error: "Cannot read file"});
      }
      res.set("Content-Type", contentTypeFor(path));
      res.body = data;
      res.sent = true;
      return res;
    },
    /**
     * Redirects with a Location header and a short text body naming
     * the target. `"back"` reads the `Referrer` header (`"/"` when
     * the dispatcher did not wire a request or none was sent).
     * @param {string} url where to go, or `"back"`
     * @param {number} [code] redirect status (default 302)
     * @returns {object} res, for chaining
     */
    redirect: function (url, code) {
      if (res.sent) return res;
      if (url === "back") {
        url = (res.req && typeof res.req.get === "function" &&
          (res.req.get("referrer") || res.req.get("referer"))) || "/";
      }
      res.statusCode = code || 302;
      res.set("Location", url);
      res.set("Content-Type", typeFor("text"));
      res.body = (STATUS_TEXTS[res.statusCode] || "Redirect") + ": " + url;
      res.sent = true;
      return res;
    },
    /**
     * Queues a `Set-Cookie` header. Every call appends (never
     * overwrites), so several cookies go out as repeated headers;
     * values are percent-encoded, `Path` defaults to `"/"`.
     * @param {string} name the cookie name (token chars only)
     * @param {*} value the cookie value (stringified)
     * @param {object} [opts] `{maxAge?, expires?, domain?, path?,
     *   httpOnly?, secure?, sameSite?}` (`sameSite: true` reads
     *   `Strict`; `"none"` gains `Secure` automatically)
     * @returns {object} res, for chaining
     */
    cookie: function (name, value, opts) {
      res._cookies.push(serializeCookie(name, value, opts));
      return res;
    },
    /**
     * Queues an expired `Set-Cookie` that clears the cookie. `path`
     * (and `domain`) must match the original cookie or browsers keep
     * it; pass the same opts you set it with.
     * @param {string} name the cookie name
     * @param {object} [opts] `{path?, domain?}` of the original cookie
     * @returns {object} res, for chaining
     */
    clearCookie: function (name, opts) {
      opts = opts || {};
      var merged = {};
      for (var k in opts) {
        if (Object.prototype.hasOwnProperty.call(opts, k)) merged[k] = opts[k];
      }
      merged.expires = new Date(1);
      res._cookies.push(serializeCookie(name, "", merged));
      return res;
    },
    /**
     * Sets the `Location` header without responding, for pairing with
     * an explicit status (`res.status(201).location("/x").end()`).
     * `"back"` reads the `Referrer` header (`"/"` fallback).
     * @param {string} url where to point, or `"back"`
     * @returns {object} res, for chaining
     */
    location: function (url) {
      if (url === "back") {
        url = (res.req && typeof res.req.get === "function" &&
          (res.req.get("referrer") || res.req.get("referer"))) || "/";
      }
      res.set("Location", url);
      return res;
    },
    /**
     * Merges `Link` response headers (`<url>; rel="name"` pairs
     * joined with `", "`), appending to any previous `links` call.
     * @param {object} obj `{rel: url}` pairs
     * @returns {object} res, for chaining
     */
    links: function (obj) {
      for (var rel in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, rel)) {
          appendHeader(res, "Link", "<" + obj[rel] + ">; rel=\"" + rel + "\"");
        }
      }
      return res;
    },
    /**
     * Ensures response header fields vary (`Vary`), appending without
     * duplicating. `"*"` replaces the whole value.
     * @param {string|string[]} field the field name(s)
     * @returns {object} res, for chaining
     */
    vary: function (field) {
      var fields = Array.isArray(field) ? field : [field];
      for (var i = 0; i < fields.length; i++) {
        if (String(fields[i]) === "*") {
          res.set("Vary", "*");
        } else {
          appendHeader(res, "Vary", String(fields[i]));
        }
      }
      return res;
    },
    /**
     * Answers just a status: the standard reason phrase as the text
     * body (`""` for unknown codes).
     * @param {number} code HTTP status code
     * @returns {object} res, for chaining
     */
    sendStatus: function (code) {
      return res.send(code);
    },
    /**
     * Marks the response as a file download (`Content-Disposition:
     * attachment`) without sending yet; pair with `sendFile`
     * (`res.attachment("a.zip").sendFile(path)`), or answer a buffer
     * directly. With no filename answers bare `attachment`.
     * @param {string} [filename] the download filename
     * @returns {object} res, for chaining
     */
    attachment: function (filename) {
      res.set("Content-Disposition", contentDisposition(filename));
      return res;
    },
    /**
     * Answers a file as a download: `Content-Disposition: attachment`
     * plus the `sendFile` body and content type. Missing files answer
     * 404 JSON like `sendFile` does.
     * @param {string} path the file path
     * @param {string} [filename] the download filename (defaults to
     *   the file's own name)
     * @returns {object} res, for chaining
     */
    download: function (path, filename) {
      if (res.sent) return res;
      var name = filename;
      if (name === undefined) {
        var parts = String(path).split("/");
        name = parts[parts.length - 1] || undefined;
      }
      res.set("Content-Disposition", contentDisposition(name));
      return res.sendFile(path);
    },
    /**
     * Answers by content negotiation: picks the first key of `obj`
     * the request's `Accept` header allows (via `req.accepts`) and
     * runs its handler. A `default` key runs when nothing matches (or
     * when the dispatcher did not wire a request); otherwise answers
     * 406 JSON. Keys are short names or MIME types, exactly as
     * `req.accepts` takes them.
     * @param {object} obj `{type: handler}` pairs plus optional
     *   `default`
     * @returns {object} res, for chaining
     */
    format: function (obj) {
      if (res.sent) return res;
      var keys = Object.keys(obj).filter(function (k) { return k !== "default"; });
      var match = false;
      if (res.req && typeof res.req.accepts === "function" && keys.length > 0) {
        match = res.req.accepts(keys);
      } else if (keys.length > 0) {
        match = keys[0];
      }
      if (match !== false && typeof obj[match] === "function") {
        obj[match]();
        return res;
      }
      if (typeof obj.default === "function") {
        obj.default();
        return res;
      }
      res.status(406).json({error: "Not Acceptable"});
      return res;
    },
    /**
     * Freezes the response into the runtime's `{status, headers, body}`
     * shape. Binary bodies without a content type default to
     * application/octet-stream; anything else becomes a string.
     * Queued cookies (`cookie()` plus any `set("Set-Cookie", ...)`
     * values, both spellings) merge into one `Set-Cookie` string or
     * an array the runtime sends as repeated headers.
     * @returns {{status: number, headers: object, body: *}} the
     *   runtime response
     */
    toRuntime: function () {
      var body = res.body;
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        body = String(body);
      }
      if (body instanceof Uint8Array &&
          res.headers["Content-Type"] === undefined) {
        res.headers["Content-Type"] = "application/octet-stream";
      }
      var cookies = res._cookies.slice();
      for (var ci = 0; ci < 2; ci++) {
        var ckey = ci === 0 ? "Set-Cookie" : "set-cookie";
        if (res.headers[ckey] !== undefined) {
          cookies.push(res.headers[ckey]);
          delete res.headers[ckey];
        }
      }
      if (cookies.length === 1) {
        res.headers["Set-Cookie"] = cookies[0];
      } else if (cookies.length > 1) {
        res.headers["Set-Cookie"] = cookies;
      }
      return {
        status: res.statusCode,
        headers: res.headers,
        body: body === undefined ? "" : body
      };
    }
  };
  return res;
}

module.exports = {
  createResponse: createResponse,
  STATUS_TEXTS: STATUS_TEXTS
};
