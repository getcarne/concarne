// concarne request ids: stamp every request with an id (`req.id`)
// and echo it back on the response. Incoming ids are trusted (proxies
// and tracers upstream own them); otherwise a `std/uuid` v4 is minted,
// falling back to a counter when uuid is unavailable.

var uuidMod = null;
try {
  uuidMod = require("std/uuid");
} catch (e) {
  uuidMod = null;
}

var fallbackSeq = 0;

/**
 * Mints an id: `std/uuid` v4 when available, otherwise a unique-ish
 * `req-<time>-<seq>` fallback (never empty, never throws).
 * @returns {string} the id
 */
function defaultGenerate() {
  try {
    if (uuidMod && typeof uuidMod.v4 === "function") return uuidMod.v4();
  } catch (e) {
    // fall through to the counter below
  }
  fallbackSeq++;
  return "req-" + Date.now() + "-" + fallbackSeq;
}

/**
 * Builds the request-id middleware.
 * @param {object} [opts] `{header?: string, generate?: Function}`:
 *   the header to trust/answer (default `"X-Request-Id"`) and the
 *   id factory (default: uuid v4)
 * @returns {Function} middleware (req, res, next)
 */
function requestId(opts) {
  opts = opts || {};
  if (typeof opts !== "object" || Array.isArray(opts)) {
    throw new Error("concarne.requestId: opts must be an object");
  }
  var header = opts.header === undefined ? "X-Request-Id" : opts.header;
  if (typeof header !== "string" || header === "") {
    throw new Error("concarne.requestId: header must be a non-empty string");
  }
  var generate = opts.generate === undefined ? defaultGenerate : opts.generate;
  if (typeof generate !== "function") {
    throw new Error("concarne.requestId: generate must be a function");
  }
  return function requestIdMiddleware(req, res, next) {
    var id = req.get(header);
    if (id === undefined || id === "") id = generate();
    req.id = String(id);
    res.set(header, req.id);
    next();
  };
}

module.exports = {requestId: requestId};
