// concarne request: wraps the runtime's raw {method, path, query, url,
// headers, body} with lazy parsed views. Parsing is hand-rolled pure JS:
// the bare JSC context has no URL/URLSearchParams.

/**
 * Builds an error the default handler respects: `err.status` decides
 * the response code, `err.message` becomes the JSON body.
 * @param {number} status HTTP status code
 * @param {string} message error message
 * @returns {Error} the error with `.status` and `.name === "HttpError"`
 */
function HttpError(status, message) {
  var err = new Error(message);
  err.name = "HttpError";
  err.status = status;
  return err;
}

/**
 * Decodes one query/cookie part: `+` becomes a space first (form
 * encoding), then percent-decoding, tolerating garbage the same way
 * route params do.
 * @param {string} s the raw part
 * @returns {string} the decoded (or original) part
 */
function decodeComponent(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch (e) {
    return s;
  }
}

/**
 * Parses a query string the way browsers mean it: repeated keys become
 * arrays (`?a=1&a=2` reads `["1", "2"]`), `?flag` reads `""`.
 * @param {string} qs the raw query, with or without leading `?`
 * @returns {Object} the parsed pairs
 */
function parseQueryString(qs) {
  var out = {};
  if (!qs) return out;
  var q = qs[0] === "?" ? qs.slice(1) : qs;
  if (q === "") return out;
  var pairs = q.split("&");
  for (var i = 0; i < pairs.length; i++) {
    var pair = pairs[i];
    if (pair === "") continue;
    var eq = pair.indexOf("=");
    var k, v;
    if (eq < 0) {
      k = pair;
      v = "";
    } else {
      k = pair.slice(0, eq);
      v = pair.slice(eq + 1);
    }
    k = decodeComponent(k);
    v = decodeComponent(v);
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      if (Array.isArray(out[k])) {
        out[k].push(v);
      } else {
        out[k] = [out[k], v];
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Parses a Cookie header into name/value pairs. Nameless fragments
 * (`foo; bar=baz`) are skipped; values are percent-decoded.
 * @param {string} header the raw Cookie header (or nothing)
 * @returns {Object} the cookies
 */
function parseCookies(header) {
  var out = {};
  if (!header) return out;
  var parts = header.split(";");
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].replace(/^\s+|\s+$/g, "");
    if (part === "") continue;
    var eq = part.indexOf("=");
    if (eq < 0) continue;
    var k = part.slice(0, eq).replace(/^\s+|\s+$/g, "");
    var v = part.slice(eq + 1).replace(/^\s+|\s+$/g, "");
    if (k !== "") out[k] = decodeComponent(v);
  }
  return out;
}

/**
 * Reads the request's media type for body parsing: lowercased, without
 * parameters (`"Application/JSON; charset=x"` reads
 * `"application/json"`).
 * @param {object} raw the runtime's raw request
 * @returns {string} the content type or `""`
 */
function contentTypeOf(raw) {
  var h = raw.headers || {};
  return (h["content-type"] || "").split(";")[0].replace(/^\s+|\s+$/g, "").toLowerCase();
}

/**
 * Wraps the runtime's raw request with the concarne shape: `method`,
 * `path`, `url`, `headers`, `rawBody`, `ip` (the peer address the
 * runtime reports as `clientIp`), empty `params` for the router to
 * fill, case-insensitive `get(name)`, and lazy `query`/`cookies`/`body`
 * (parsed once on first read, so untouched requests cost nothing).
 * JSON bodies throw a 400 `HttpError` on invalid input.
 * @param {object} raw the runtime's raw `{method, path, query, url,
 *   headers, body, clientIp}` request
 * @returns {object} the concarne request
 */
function wrapRequest(raw) {
  var cachedQuery, cachedBody, cachedCookies;
  var hasQuery = false, hasBody = false, hasCookies = false;
  var req = {
    method: raw.method,
    path: raw.path,
    url: raw.url,
    headers: raw.headers || {},
    rawBody: raw.body || "",
    ip: raw.clientIp || "",
    params: {},
    get: function (name) {
      return req.headers[String(name).toLowerCase()];
    }
  };
  Object.defineProperty(req, "query", {
    get: function () {
      if (!hasQuery) {
        cachedQuery = parseQueryString(raw.query || "");
        hasQuery = true;
      }
      return cachedQuery;
    }
  });
  Object.defineProperty(req, "cookies", {
    get: function () {
      if (!hasCookies) {
        cachedCookies = parseCookies(req.headers["cookie"]);
        hasCookies = true;
      }
      return cachedCookies;
    }
  });
  Object.defineProperty(req, "body", {
    get: function () {
      if (!hasBody) {
        var ct = contentTypeOf(raw);
        if (ct === "application/json" || ct.slice(-5) === "+json") {
          var text = (raw.body || "").replace(/^\s+|\s+$/g, "");
          if (text === "") {
            cachedBody = {};
          } else {
            try {
              cachedBody = JSON.parse(text);
            } catch (e) {
              throw HttpError(400, "Invalid JSON body");
            }
          }
        } else if (ct === "application/x-www-form-urlencoded") {
          cachedBody = parseQueryString(raw.body || "");
        } else {
          cachedBody = raw.body || "";
        }
        hasBody = true;
      }
      return cachedBody;
    }
  });
  return req;
}

module.exports = {
  wrapRequest: wrapRequest,
  parseQueryString: parseQueryString,
  HttpError: HttpError
};
