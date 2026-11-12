// concarne CORS: cross-origin middleware in the express `cors` shape.
//
//   const concarne = require("pkg/concarne");
//   app.use(concarne.cors());
//   app.use(concarne.cors({origin: "https://app.example.com", credentials: true}));
//
// Requests without an Origin header are not CORS requests and pass
// through untouched. Preflight OPTIONS requests end here with
// optionsSuccessStatus (default 204) unless preflightContinue is set.
// Sync only, like every concarne middleware in v1.

/**
 * Builds a CORS middleware.
 * @param {object} [opts] options bag
 * @param {string|string[]|function|boolean} [opts.origin] allowed origin:
 *   `"*"` (default), an exact string, an array of exact strings, `true`
 *   to reflect the request origin, or `function (origin)` returning
 *   `true`, an allowed string, or a falsy value to deny
 * @param {string|string[]} [opts.methods] value for
 *   Access-Control-Allow-Methods (default
 *   `"GET,HEAD,PUT,PATCH,POST,DELETE"`)
 * @param {string|string[]} [opts.allowedHeaders] value for
 *   Access-Control-Allow-Headers (default: reflect the request's
 *   Access-Control-Request-Headers)
 * @param {string|string[]} [opts.exposedHeaders] value for
 *   Access-Control-Expose-Headers
 * @param {boolean} [opts.credentials] set
 *   Access-Control-Allow-Credentials (default false)
 * @param {number} [opts.maxAge] seconds for Access-Control-Max-Age
 * @param {number} [opts.optionsSuccessStatus] preflight end status
 *   (default 204)
 * @param {boolean} [opts.preflightContinue] pass preflights to next()
 *   instead of ending them (default false)
 * @returns {function} middleware (req, res, next)
 */
function cors(opts) {
  opts = opts || {};
  var methods = opts.methods === undefined
    ? "GET,HEAD,PUT,PATCH,POST,DELETE"
    : toList(opts.methods, "methods").join(", ");
  var allowedHeaders = opts.allowedHeaders === undefined
    ? null
    : toList(opts.allowedHeaders, "allowedHeaders");
  var exposedHeaders = opts.exposedHeaders === undefined
    ? null
    : toList(opts.exposedHeaders, "exposedHeaders");
  var credentials = opts.credentials === true;
  var maxAge = opts.maxAge;
  if (maxAge !== undefined &&
      (typeof maxAge !== "number" || !(maxAge >= 0))) {
    throw new Error("concarne.cors: maxAge must be a number >= 0");
  }
  var successStatus = opts.optionsSuccessStatus === undefined
    ? 204
    : opts.optionsSuccessStatus;
  if (typeof successStatus !== "number" ||
      successStatus < 200 || successStatus > 299) {
    throw new Error("concarne.cors: optionsSuccessStatus must be a 2xx number");
  }
  var preflightContinue = opts.preflightContinue === true;
  if (opts.origin !== undefined && opts.origin !== null &&
      opts.origin !== "*" && opts.origin !== true &&
      typeof opts.origin !== "string" &&
      !Array.isArray(opts.origin) &&
      typeof opts.origin !== "function") {
    throw new Error(
      "concarne.cors: origin must be a string, array, function, true or \"*\"");
  }

  return function corsMiddleware(req, res, next) {
    var requestOrigin = req.get("origin");
    if (!requestOrigin) {
      // Not a CORS request (same-origin fetch, curl): behave as if
      // the middleware were not there.
      next();
      return;
    }
    var resolved;
    try {
      resolved = resolveOrigin(opts.origin, requestOrigin);
    } catch (e) {
      next(e);
      return;
    }
    if (resolved.allowed) {
      // A wildcard cannot carry credentials per the spec: when the app
  // asked for credentials under allow-all, reflect the request origin
  // so browsers accept the response.
      var allowOrigin = (credentials && resolved.value === "*")
        ? requestOrigin
        : resolved.value;
      res.set("Access-Control-Allow-Origin", allowOrigin);
      if (allowOrigin !== "*") appendVary(res, "Origin");
      if (credentials) res.set("Access-Control-Allow-Credentials", "true");
      if (exposedHeaders !== null) {
        res.set("Access-Control-Expose-Headers", exposedHeaders.join(", "));
      }
    }
    if (req.method === "OPTIONS" && req.get("access-control-request-method")) {
      // A denied preflight still ends here (with no CORS headers, so
      // browsers block it) instead of falling into the app's routes:
      // the browser never exposes the response either way, and ending
      // keeps OPTIONS off the route table.
      if (resolved.allowed) {
        res.set("Access-Control-Allow-Methods", methods);
        var allowH = allowedHeaders !== null
          ? allowedHeaders.join(", ")
          : (req.get("access-control-request-headers") || "");
        if (allowH !== "") res.set("Access-Control-Allow-Headers", allowH);
        if (maxAge !== undefined) {
          res.set("Access-Control-Max-Age", String(Math.floor(maxAge)));
        }
      }
      if (preflightContinue) {
        next();
        return;
      }
      res.status(successStatus).end("");
      return;
    }
    next();
  };
}

/**
 * Normalizes a string-or-array option into an array of strings.
 * Comma-separated strings are split so `"GET, POST"` and
 * `["GET", "POST"]` spell the same thing.
 * @param {string|string[]} v the option value
 * @param {string} name option name for the throw message
 * @returns {string[]} the values, trimmed and non-empty
 */
function toList(v, name) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    return v.split(",").map(function (s) {
      return s.replace(/^\s+|\s+$/g, "");
    }).filter(function (s) { return s !== ""; });
  }
  throw new Error("concarne.cors: " + name + " must be a string or an array");
}

/**
 * Matches the request origin against the `origin` option.
 * @param {string|string[]|function|boolean|undefined} originOpt the
 *   configured `origin` (`undefined`/`"*"` means allow-all)
 * @param {string} requestOrigin the request's Origin header
 * @returns {{allowed: boolean, value?: string}} whether to answer, and
 *   which origin to echo back when allowed
 */
function resolveOrigin(originOpt, requestOrigin) {
  if (originOpt === undefined || originOpt === null || originOpt === "*") {
    return {allowed: true, value: "*"};
  }
  if (originOpt === true) {
    return {allowed: true, value: requestOrigin};
  }
  if (typeof originOpt === "string") {
    return originOpt === requestOrigin
      ? {allowed: true, value: originOpt}
      : {allowed: false};
  }
  if (Array.isArray(originOpt)) {
    for (var i = 0; i < originOpt.length; i++) {
      if (String(originOpt[i]) === requestOrigin) {
        return {allowed: true, value: requestOrigin};
      }
    }
    return {allowed: false};
  }
  var r = originOpt(requestOrigin);
  if (r === true) return {allowed: true, value: requestOrigin};
  if (typeof r === "string") return {allowed: true, value: r};
  return {allowed: false};
}

/**
 * Adds a value to the Vary header without duplicating it. Reads both
 * `Vary` and `vary` because header keys are case-sensitive here while
 * the wire is not.
 * @param {object} res the concarne response
 * @param {string} value the value to ensure (e.g. `"Origin"`)
 * @returns {undefined}
 */
function appendVary(res, value) {
  var cur = res.get("Vary");
  if (cur === undefined) cur = res.get("vary");
  if (cur === undefined || cur === "") {
    res.set("Vary", value);
    return;
  }
  var parts = String(cur).split(",");
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].replace(/^\s+|\s+$/g, "") === value) return;
  }
  res.set("Vary", String(cur) + ", " + value);
}

module.exports = {cors: cors};
