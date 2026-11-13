// concarne bodies: the json/urlencoded limit middleware. Multipart
// parsing lives in the runtime, not here: powpow auto-streams
// multipart/form-data uploads to tmpfiles from the first body byte
// (per-file/per-field/total caps from the serve `maxBodySize` opt
// enforced at the protocol level, binary-safe throughout), and
// `std/http` exposes them as the lazy `req.multipart` field
// (`{fields, files}` with file tmp paths). `req.body` reads the
// fields, `req.files` the files with eagerly-read binary-safe
// `Uint8Array` data. Tmpfiles vanish after the handler returns, so
// consume uploads during handling; file parts need a filename and a
// Content-Type header (what curl and browsers send).

/**
 * Builds a 413 error the default handler answers as JSON.
 * @param {string} message the error message
 * @returns {Error} the error with `.status === 413`
 */
function tooLarge(message) {
  var err = new Error(message);
  err.status = 413;
  return err;
}

/**
 * Parses a size limit: a byte count, or a `"100kb"`/`"2mb"`/`"1gb"`
 * string (case-insensitive, fractional counts allowed).
 * @param {number|string} limit the configured limit
 * @param {string} name the option name for the throw message
 * @returns {number} the limit in bytes
 */
function parseLimit(limit, name) {
  if (typeof limit === "number") {
    if (!(limit >= 0)) {
      throw new Error("concarne: " + name + " must be bytes >= 0");
    }
    return Math.floor(limit);
  }
  var m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(limit));
  if (!m) {
    throw new Error("concarne: " + name + " must be bytes or like \"100kb\"");
  }
  var n = parseFloat(m[1]);
  var unit = (m[2] || "b").toLowerCase();
  var mult = unit === "gb" ? 1024 * 1024 * 1024
    : unit === "mb" ? 1024 * 1024
    : unit === "kb" ? 1024 : 1;
  return Math.floor(n * mult);
}

/**
 * Builds a body-limiting middleware factory shared by `json` and
 * `urlencoded`: skips other content types, answers 413 past the
 * limit, and eagerly parses so malformed bodies fail here (400)
 * instead of deep in a route.
 * @param {string} factory the factory name for throw messages
 * @param {Function} matches `matches(mediaType)` for the content type
 * @param {string} optName the limit option name for throw messages
 * @returns {Function} the factory `(opts?) => middleware`
 */
function limitFactory(factory, matches, optName) {
  return function (opts) {
    opts = opts || {};
    if (typeof opts !== "object" || Array.isArray(opts)) {
      throw new Error("concarne." + factory + ": opts must be an object");
    }
    var limit = opts.limit === undefined ? "100kb" : opts.limit;
    var bytes = parseLimit(limit, optName);
    return function bodyLimit(req, res, next) {
      var ct = (req.get("content-type") || "").split(";")[0]
        .replace(/^\s+|\s+$/g, "").toLowerCase();
      if (!matches(ct)) {
        next();
        return;
      }
      if ((req.rawBody || "").length > bytes) {
        next(tooLarge("Body too large"));
        return;
      }
      try {
        void req.body;
      } catch (e) {
        next(e);
        return;
      }
      next();
    };
  };
}

/**
 * JSON body middleware: skips non-JSON content types, answers 413
 * past `limit` (default `"100kb"`, bytes or `"Nkb"/"Nmb"/"Ngb"`),
 * and eagerly parses so invalid JSON fails 400 here.
 */
var json = limitFactory("json", function (ct) {
  return ct === "application/json" || ct.slice(-5) === "+json";
}, "limit");

/**
 * Urlencoded body middleware: same shape as `json()` for
 * `application/x-www-form-urlencoded` bodies (flat pairs only;
 * nested `a[b]` syntax stays a literal key).
 */
var urlencoded = limitFactory("urlencoded", function (ct) {
  return ct === "application/x-www-form-urlencoded";
}, "limit");

module.exports = {
  parseLimit: parseLimit,
  json: json,
  urlencoded: urlencoded
};
