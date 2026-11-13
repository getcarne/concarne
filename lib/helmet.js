// concarne helmet: security response headers in the helmet shape,
// but as one in-core middleware with per-header opts. Headers already
// set by the app win (never overwritten); pass `false` to skip one.
// `X-Powered-By` needs no removal: concarne never sets it.

/**
 * Normalizes one header option: `false` disables, `true`/`undefined`
 * takes the default, a string overrides the value.
 * @param {*} opt the option value
 * @param {string} name the option name for the throw message
 * @param {string} fallback the default header value
 * @returns {string|null} the value to send, or null when disabled
 */
function resolveHeader(opt, name, fallback) {
  if (opt === undefined || opt === true) return fallback;
  if (opt === false || opt === null) return null;
  if (typeof opt !== "string" || opt === "") {
    throw new Error("concarne.helmet: " + name + " must be a string or false");
  }
  return opt;
}

/**
 * Builds the security-headers middleware.
 * @param {object} [opts] per-header opts (each a string override or
 *   `false` to skip): `contentTypeOptions` (default `"nosniff"`),
 *   `frameOptions` (default `"SAMEORIGIN"`), `dnsPrefetchControl`
 *   (default `"off"`), `referrerPolicy` (default `"no-referrer"`),
 *   `crossOriginOpenerPolicy` (default `"same-origin"`),
 *   `originAgentCluster` (default `"?1"`)
 * @returns {Function} middleware (req, res, next)
 */
function helmet(opts) {
  opts = opts || {};
  if (typeof opts !== "object" || Array.isArray(opts)) {
    throw new Error("concarne.helmet: opts must be an object");
  }
  var headers = [
    ["X-Content-Type-Options",
      resolveHeader(opts.contentTypeOptions, "contentTypeOptions", "nosniff")],
    ["X-Frame-Options",
      resolveHeader(opts.frameOptions, "frameOptions", "SAMEORIGIN")],
    ["X-DNS-Prefetch-Control",
      resolveHeader(opts.dnsPrefetchControl, "dnsPrefetchControl", "off")],
    ["Referrer-Policy",
      resolveHeader(opts.referrerPolicy, "referrerPolicy", "no-referrer")],
    ["Cross-Origin-Opener-Policy",
      resolveHeader(opts.crossOriginOpenerPolicy, "crossOriginOpenerPolicy", "same-origin")],
    ["Origin-Agent-Cluster",
      resolveHeader(opts.originAgentCluster, "originAgentCluster", "?1")]
  ];
  return function helmetMiddleware(req, res, next) {
    for (var i = 0; i < headers.length; i++) {
      if (headers[i][1] !== null && res.get(headers[i][0]) === undefined) {
        res.set(headers[i][0], headers[i][1]);
      }
    }
    next();
  };
}

module.exports = {helmet: helmet};
