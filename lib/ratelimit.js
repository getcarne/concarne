// concarne rate limit: fixed-window per-key request cap. Fixed window
// (rather than sliding) keeps every request to a single store lookup,
// and the boundary burst it allows is the documented tradeoff.
//
//   const concarne = require("pkg/concarne");
//   app.use(concarne.rateLimit({windowMs: 60000, limit: 100}));
//
// Counters live in process memory, so each worker under workers > 1
// keeps its own counters: set limits conservatively when serving
// multi-worker. Sync only, like every concarne middleware in v1.

/**
 * Builds a rate-limiting middleware (fixed window).
 * @param {object} [opts] options bag
 * @param {number} [opts.windowMs] window length in ms (default 60000)
 * @param {number} [opts.limit] max requests per window per key
 *   (default 100, alias `max`)
 * @param {function} [opts.key] key selector `function (req)` (default:
 *   `req.ip`, the runtime's peer address)
 * @param {string|object} [opts.message] 429 body, sent as text or JSON
 *   (default `"Too many requests"`)
 * @param {number} [opts.statusCode] 429 status (default 429)
 * @param {boolean} [opts.headers] send `RateLimit-Limit/Remaining/Reset`
 *   plus `Retry-After` on 429 (default true)
 * @param {function} [opts.skip] `function (req)` returning true bypasses
 *   counting (default none)
 * @param {function} [opts.onLimit] `function (req, res)` custom 429
 *   responder (default: status(message))
 * @returns {function} middleware (req, res, next) with `.reset(key)`
 *   and `.clear()` helpers
 */
function rateLimit(opts) {
  opts = opts || {};
  var windowMs = opts.windowMs === undefined ? 60000 : opts.windowMs;
  if (typeof windowMs !== "number" || !(windowMs > 0)) {
    throw new Error("concarne.rateLimit: windowMs must be a number > 0");
  }
  var limit = opts.limit === undefined ? opts.max : opts.limit;
  if (limit === undefined) limit = 100;
  if (typeof limit !== "number" || Math.floor(limit) !== limit || limit < 1) {
    throw new Error("concarne.rateLimit: limit must be an integer >= 1");
  }
  var keyFn = opts.key === undefined ? defaultKey : opts.key;
  if (typeof keyFn !== "function") {
    throw new Error("concarne.rateLimit: key must be a function");
  }
  var statusCode = opts.statusCode === undefined ? 429 : opts.statusCode;
  if (typeof statusCode !== "number" ||
      Math.floor(statusCode) !== statusCode ||
      statusCode < 400 || statusCode > 599) {
    throw new Error("concarne.rateLimit: statusCode must be a 4xx/5xx number");
  }
  var message = opts.message === undefined ? "Too many requests" : opts.message;
  var sendHeaders = opts.headers !== false;
  var skip = opts.skip === undefined ? null : opts.skip;
  if (skip !== null && typeof skip !== "function") {
    throw new Error("concarne.rateLimit: skip must be a function");
  }
  var onLimit = opts.onLimit === undefined ? null : opts.onLimit;
  if (onLimit !== null && typeof onLimit !== "function") {
    throw new Error("concarne.rateLimit: onLimit must be a function");
  }

  // Null-prototype store: keys come from user input (IPs, paths), so a
  // plain object would collide with inherited names like "toString"
  // and corrupt the counts.
  var hits = Object.create(null);
  var ops = 0;

  /**
   * Drops every counter whose window has passed. Called every 1000
   * hits so idle keys cannot pin memory, while hot paths stay a
   * single object lookup.
   * @param {number} now Date.now() at the current request
   * @returns {undefined}
   */
  function sweep(now) {
    for (var k in hits) {
      if (hits[k].reset <= now) delete hits[k];
    }
  }

  /**
   * The middleware: counts this request against its key's window,
   * stamps the RateLimit headers, and either passes on or answers 429.
   * @param {object} req the concarne request
   * @param {object} res the concarne response
   * @param {function} next continue the stack
   * @returns {undefined}
   */
  function middleware(req, res, next) {
    var key;
    try {
      if (skip !== null && skip(req)) {
        next();
        return;
      }
      key = String(keyFn(req));
    } catch (e) {
      next(e);
      return;
    }
    var now = Date.now();
    var slot = hits[key];
    if (slot === undefined || now >= slot.reset) {
      slot = {count: 0, reset: now + windowMs};
      hits[key] = slot;
    }
    slot.count++;
    // Bound memory without a timer: expired windows fall out lazily
    // above, and every 1000 hits purges the leftovers.
    if (++ops % 1000 === 0) sweep(now);
    var remaining = limit - slot.count;
    if (remaining < 0) remaining = 0;
    var resetSec = Math.ceil((slot.reset - now) / 1000);
    if (resetSec < 0) resetSec = 0;
    if (sendHeaders) {
      res.set("RateLimit-Limit", String(limit));
      res.set("RateLimit-Remaining", String(remaining));
      res.set("RateLimit-Reset", String(resetSec));
    }
    if (slot.count > limit) {
      if (sendHeaders) res.set("Retry-After", String(resetSec));
      if (onLimit !== null) {
        try {
          onLimit(req, res);
        } catch (e) {
          next(e);
        }
        return;
      }
      res.status(statusCode);
      if (typeof message === "object" && message !== null) res.json(message);
      else res.send(String(message));
      return;
    }
    next();
  }

  /**
   * Forgets one key's counter, e.g. after a successful login or in
   * tests. Unknown keys are a no-op.
   * @param {string} key the key as `key(req)` returned it
   * @returns {undefined}
   */
  middleware.reset = function (key) {
    delete hits[String(key)];
  };

  /**
   * Empties the whole store: every key starts a fresh window.
   * @returns {undefined}
   */
  middleware.clear = function () {
    hits = Object.create(null);
    ops = 0;
  };

  return middleware;
}

/**
 * Default key selector: the runtime's peer address, exposed as
 * `req.ip`. Empty when the runtime did not report one, in which case
 * every such request shares a single bucket (pass an explicit `key`
 * when that is wrong for your app).
 * @param {object} req the concarne request
 * @returns {string} the client key
 */
function defaultKey(req) {
  return req.ip || "";
}

module.exports = {rateLimit: rateLimit};
