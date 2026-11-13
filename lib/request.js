// concarne request: wraps the runtime's raw {method, path, query, url,
// headers, body} with lazy parsed views. Parsing is hand-rolled pure JS:
// the bare JSC context has no URL/URLSearchParams.

const mimetype = require("std/mimetype");
const os = require("std/os");

/**
 * Flattens nested handler/type arrays in place order.
 * @param {Array} out the accumulator
 * @param {Array} fns the (possibly nested) list
 * @returns {Array} the flat list
 */
function flattenInto(out, fns) {
  for (var i = 0; i < fns.length; i++) {
    if (Array.isArray(fns[i])) flattenInto(out, fns[i]);
    else out.push(fns[i]);
  }
  return out;
}

/**
 * Resolves an offered type to a MIME type for Accept matching: short
 * names (`"html"`, `"json"`, ...) go through `std/mimetype` (bare,
 * no charset suffix), full types pass through lowercased.
 * @param {string} t the offered type or short name
 * @returns {string} the MIME type, or `""` when unresolvable
 */
function mimeOf(t) {
  if (t.indexOf("/") >= 0) return t.toLowerCase();
  var found = mimetype.lookup(t);
  return found === null || found === undefined || found === "" ? "" : found;
}

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
 * Picks the request's peer address. With `trust proxy` the leftmost
 * `X-Forwarded-For` entry wins (the client-facing hop); otherwise the
 * runtime's direct peer address. Empty when neither is known, in which
 * case every such request shares one rate-limit bucket.
 * @param {object} headers the lowercased request headers
 * @param {string} clientIp the runtime's direct peer address
 * @param {boolean} trust whether `trust proxy` is enabled
 * @returns {string} the client address
 */
function peerAddress(headers, clientIp, trust) {
  if (trust) {
    var fwd = (headers["x-forwarded-for"] || "").split(",")[0].replace(/^\s+|\s+$/g, "");
    if (fwd !== "") return fwd;
  }
  return clientIp || "";
}

/**
 * Picks the request protocol. Plain `"http"` unless `trust proxy` is
 * enabled and the proxy says otherwise via `X-Forwarded-Proto`.
 * @param {object} headers the lowercased request headers
 * @param {boolean} trust whether `trust proxy` is enabled
 * @returns {string} the protocol, lowercased
 */
function requestProtocol(headers, trust) {
  if (trust) {
    var proto = (headers["x-forwarded-proto"] || "").split(",")[0].replace(/^\s+|\s+$/g, "").toLowerCase();
    if (proto !== "") return proto;
  }
  return "http";
}

/**
 * Picks the request hostname: the `Host` (or `X-Forwarded-Host` under
 * `trust proxy`) header without the port, lowercased. IPv6 literals
 * keep their brackets (`"[::1]:3000"` reads `"[::1]"`).
 * @param {object} headers the lowercased request headers
 * @param {boolean} trust whether `trust proxy` is enabled
 * @returns {string} the hostname or `""`
 */
function requestHostname(headers, trust) {
  var host = trust
    ? (headers["x-forwarded-host"] || headers["host"] || "")
    : (headers["host"] || "");
  host = host.split(",")[0].replace(/^\s+|\s+$/g, "").toLowerCase();
  if (host === "") return "";
  if (host[0] === "[") {
    var end = host.indexOf("]");
    return end >= 0 ? host.slice(0, end + 1) : host;
  }
  return host.split(":")[0];
}

/**
 * Parses an `Accept` header into `{type, q}` entries in header order.
 * Entries default to `q=1`; garbage (`q` outside 0..1, empty types)
 * is dropped rather than failing the whole header.
 * @param {string} header the raw Accept header (or nothing)
 * @returns {Array<{type: string, q: number}>} the accepted ranges
 */
function parseAccept(header) {
  var out = [];
  if (!header) return out;
  var parts = header.split(",");
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i].split(";");
    var type = seg[0].replace(/^\s+|\s+$/g, "").toLowerCase();
    if (type === "" || type.indexOf("/") < 0) continue;
    var q = 1;
    for (var j = 1; j < seg.length; j++) {
      var kv = seg[j].split("=");
      if (kv.length === 2 &&
          kv[0].replace(/^\s+|\s+$/g, "").toLowerCase() === "q") {
        var n = parseFloat(kv[1]);
        if (!isNaN(n) && n >= 0 && n <= 1) q = n;
      }
    }
    out.push({type: type, q: q});
  }
  return out;
}

/**
 * Scores one offered type against the parsed Accept list: exact match
 * wins over `type/` wildcards, which win over a bare star range.
 * @param {string} mime the offered MIME type, lowercased
 * @param {Array<{type: string, q: number}>} accepted the parsed header
 * @returns {number} the best quality value, 0..1
 */
function acceptQuality(mime, accepted) {
  var wild = 0;
  var typeWild = 0;
  var slash = mime.indexOf("/");
  var prefix = slash >= 0 ? mime.slice(0, slash + 1) : null;
  for (var i = 0; i < accepted.length; i++) {
    var a = accepted[i];
    if (a.type === mime) return a.q;
    if (a.type === "*/*") {
      wild = a.q;
    } else if (prefix !== null && a.type === prefix + "*") {
      typeWild = a.q;
    }
  }
  // An exact miss still honors ranges: prefer the narrower one when
  // both match.
  return typeWild > 0 ? typeWild : wild;
}

/**
 * Reads a request header case-insensitively. Shared by every request
 * (wrapping allocates no closure for it).
 * @param {string} name the header name
 * @returns {string|undefined} the value, or nothing when unset
 */
function reqGet(name) {
  return this.headers[String(name).toLowerCase()];
}

/**
 * Negotiates the response type against the request's `Accept`
 * header. With no arguments answers the accepted ranges in
 * priority order; otherwise answers the first offered type the
 * client accepts (`false` when none match). Offered types may be
 * short names (`"html"`, `"json"`) resolved through `std/mimetype`
 * or full MIME types; matching honors `q` values and wildcard
 * ranges. The answer echoes the offered value
 * (short name or MIME), so `res.format` can key on it directly.
 * Shared by every request.
 * @param {...string|string[]} types offered types (arrays flatten)
 * @returns {string|string[]|false} the match, the ranges, or false
 */
function reqAccepts() {
  var offered = flattenInto([], Array.prototype.slice.call(arguments));
  var accepted = parseAccept(this.headers["accept"]);
  if (accepted.length === 0) {
    // No (parseable) Accept header: the client takes anything, so
    // the server's first choice wins, exactly like `*/*`.
    return offered.length > 0 ? offered[0] : ["*/*"];
  }
  if (offered.length === 0) {
    return accepted.filter(function (a) { return a.q > 0; })
      .sort(function (x, y) { return y.q - x.q; })
      .map(function (a) { return a.type; });
  }
  var best = false;
  var bestQ = 0;
  for (var i = 0; i < offered.length; i++) {
    var mime = mimeOf(String(offered[i]));
    if (mime === "") continue;
    var q = acceptQuality(mime, accepted);
    if (q > bestQ) {
      bestQ = q;
      best = offered[i];
    }
  }
  return bestQ > 0 ? best : false;
}

/**
 * Wraps the runtime's raw request with the concarne shape: `method`,
 * `path`, `url`, `originalUrl` (never rewritten, even under mounted
 * Routers), `baseUrl` (the mount prefix accumulated so far, `""` at
 * the top level), `headers`, `rawBody`, `ip` (peer address, or the
 * leftmost `X-Forwarded-For` entry under `trust proxy`), `hostname`
 * (from `Host`, or `X-Forwarded-Host` under `trust proxy`),
 * `protocol` (`"http"` unless `trust proxy` sees `X-Forwarded-Proto`),
 * `secure` (`protocol === "https"`), `xhr` (whether
 * `X-Requested-With` is `XMLHttpRequest`), `id` (request id, `""`
 * until `requestId()` or the app sets one), empty `params` for the
 * router to fill, case-insensitive `get(name)`, content-negotiating
 * `accepts(...)`, parsed `files` for multipart uploads (`[{field,
 * filename, contentType, size, path, data}]`, `data` a binary-safe
 * `Uint8Array` read eagerly while the tmpfile lives), and lazy
 * `headers`/`rawBody`/`ip`/`hostname`/`protocol`/`secure`/`xhr` plus
 * lazy `query`/`cookies`/`body` (parsed once on first read, so
 * untouched requests never materialize the header table or copy the
 * body). Multipart text
 * fields land in `body`; JSON bodies throw a 400 `HttpError` on
 * invalid input.
 * @param {object} raw the runtime's raw `{method, path, query, url,
 *   headers, body, clientIp}` request
 * @param {object} [opts] wrap options: `{trustProxy?: boolean}`
 * @returns {object} the concarne request
 */
function wrapRequest(raw, opts) {
  var trust = !!opts && opts.trustProxy === true;
  var cachedQuery, cachedBody, cachedCookies, cachedFiles;
  var hasQuery = false, hasBody = false, hasCookies = false, hasFiles = false;
  // Snapshots deferred to first read (see below): untouched requests
  // never materialize headers or copy the body, so the benchmark path
  // (method + path only) pays ~nothing for the request object. The
  // accessors below are per-request closures; `get`/`accepts` are
  // shared instead (they only use `this`).
  var cachedHeaders, cachedRawBody, cachedIp, cachedHostname, cachedProtocol;
  var hasHeaders = false, hasRawBody = false, hasIp = false,
    hasHostname = false, hasProto = false;
  var req = {
    method: raw.method,
    path: raw.path,
    url: raw.url,
    originalUrl: raw.url,
    baseUrl: "",
    /**
     * The request headers, lowercased by the runtime. Snapshotted
     * from the raw request on first read (materializing the header
     * table costs), then cached; assignable like before.
     * @returns {object} the headers
     */
    get headers() {
      if (!hasHeaders) {
        cachedHeaders = raw.headers || {};
        hasHeaders = true;
      }
      return cachedHeaders;
    },
    /**
     * Overrides the cached headers.
     * @param {object} v the headers to use from now on
     * @returns {undefined}
     */
    set headers(v) {
      cachedHeaders = v;
      hasHeaders = true;
    },
    /**
     * The raw request body as a string. Copied from the runtime on
     * first read, then cached; assignable like before.
     * @returns {string} the body
     */
    get rawBody() {
      if (!hasRawBody) {
        cachedRawBody = raw.body || "";
        hasRawBody = true;
      }
      return cachedRawBody;
    },
    /**
     * Overrides the cached raw body.
     * @param {string} v the body to use from now on
     * @returns {undefined}
     */
    set rawBody(v) {
      cachedRawBody = v;
      hasRawBody = true;
    },
    /**
     * The peer address: the runtime's direct peer, or the leftmost
     * `X-Forwarded-For` entry under `trust proxy`. Derived on first
     * read, then cached; assignable like before.
     * @returns {string} the client address
     */
    get ip() {
      if (!hasIp) {
        cachedIp = peerAddress(this.headers, raw.clientIp || "", trust);
        hasIp = true;
      }
      return cachedIp;
    },
    /**
     * Overrides the cached peer address.
     * @param {string} v the address to use from now on
     * @returns {undefined}
     */
    set ip(v) {
      cachedIp = v;
      hasIp = true;
    },
    /**
     * The request hostname: `Host` without the port, lowercased (or
     * `X-Forwarded-Host` under `trust proxy`). Derived on first read,
     * then cached; assignable like before.
     * @returns {string} the hostname
     */
    get hostname() {
      if (!hasHostname) {
        cachedHostname = requestHostname(this.headers, trust);
        hasHostname = true;
      }
      return cachedHostname;
    },
    /**
     * Overrides the cached hostname.
     * @param {string} v the hostname to use from now on
     * @returns {undefined}
     */
    set hostname(v) {
      cachedHostname = v;
      hasHostname = true;
    },
    /**
     * The request protocol: `"http"` unless `trust proxy` sees
     * `X-Forwarded-Proto`. Derived on first read, then cached;
     * assignable like before.
     * @returns {string} the protocol
     */
    get protocol() {
      if (!hasProto) {
        cachedProtocol = requestProtocol(this.headers, trust);
        hasProto = true;
      }
      return cachedProtocol;
    },
    /**
     * Overrides the cached protocol.
     * @param {string} v the protocol to use from now on
     * @returns {undefined}
     */
    set protocol(v) {
      cachedProtocol = v;
      hasProto = true;
    },
    /**
     * Whether the request came over TLS (`protocol === "https"`).
     * @returns {boolean} true when secure
     */
    get secure() {
      return this.protocol === "https";
    },
    /**
     * Assigning still works; reading derives from protocol (as
     * documented), so `req.secure = true` reads back true.
     * @param {boolean} v the secure flag
     * @returns {undefined}
     */
    set secure(v) {
      if (v) this.protocol = "https";
      else if (this.protocol === "https") this.protocol = "http";
    },
    /**
     * Whether `X-Requested-With` is `XMLHttpRequest`. Derived from
     * the headers on every read, like the old eager snapshot.
     * @returns {boolean} true for XHR requests
     */
    get xhr() {
      return (this.headers["x-requested-with"] || "").toLowerCase() ===
        "xmlhttprequest";
    },
    /**
     * Overrides the underlying header, so the getter reads it back.
     * @param {*} v truthy marks XHR, falsy clears it
     * @returns {undefined}
     */
    set xhr(v) {
      var h = this.headers;
      h["x-requested-with"] = v ? "XMLHttpRequest" : "";
    },
    id: "",
    params: {},
    get: reqGet,
    accepts: reqAccepts
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
        } else if (ct === "multipart/form-data") {
          // Parsed by the runtime (powpow streams uploads to tmpfiles
          // from the first body byte): fields here, files on req.files.
          var mp = raw.multipart || {fields: {}};
          cachedBody = mp.fields || {};
        } else {
          cachedBody = raw.body || "";
        }
        hasBody = true;
      }
      return cachedBody;
    }
  });
  Object.defineProperty(req, "files", {
    get: function () {
      if (!hasFiles) {
        // Tmp paths vanish after the handler returns, so data is read
        // eagerly (binary-safe Uint8Arrays) while the files are here.
        // Old runtimes without the `multipart` field read empty.
        var list = ((raw.multipart || {}).files) || [];
        cachedFiles = [];
        for (var i = 0; i < list.length; i++) {
          var f = list[i];
          var data = null;
          if (f.path) {
            try {
              data = os.readFileBytes(f.path);
            } catch (e) {
              throw HttpError(500, "Cannot read upload");
            }
          }
          cachedFiles.push({
            field: f.field,
            filename: f.filename,
            contentType: f.contentType,
            size: f.size,
            path: f.path,
            data: data
          });
        }
        hasFiles = true;
      }
      return cachedFiles;
    }
  });
  return req;
}

module.exports = {
  wrapRequest: wrapRequest,
  parseQueryString: parseQueryString,
  HttpError: HttpError
};
