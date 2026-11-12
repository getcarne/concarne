// concarne response: collects status/headers/body, maps onto the
// runtime's {status, headers, body} handler return. All mutators are
// chainable. Sending twice is a no-op (first send wins). Bodies may be
// strings or Uint8Arrays: binary passes through std/http untouched
// (Content-Type defaults to application/octet-stream), strings keep
// the text defaults.

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
 * Starts a fresh response: status 200, no headers, nothing sent. Every
 * mutator returns `res` for chaining, and sending twice is a no-op
 * (first send wins).
 * @returns {object} the concarne response
 */
function createResponse() {
  var res = {
    statusCode: 200,
    headers: {},
    body: "",
    sent: false,
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
     * the target.
     * @param {string} url where to go
     * @param {number} [code] redirect status (default 302)
     * @returns {object} res, for chaining
     */
    redirect: function (url, code) {
      if (res.sent) return res;
      res.statusCode = code || 302;
      res.set("Location", url);
      res.set("Content-Type", typeFor("text"));
      res.body = (STATUS_TEXTS[res.statusCode] || "Redirect") + ": " + url;
      res.sent = true;
      return res;
    },
    /**
     * Freezes the response into the runtime's `{status, headers, body}`
     * shape. Binary bodies without a content type default to
     * application/octet-stream; anything else becomes a string.
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
