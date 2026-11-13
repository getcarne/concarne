// concarne logger: morgan-style request logging. Runs after `next()`
// returns, so the status it prints is final (every v1 handler is
// synchronous). Colors follow `std/terminal`'s TTY gate, so piped
// logs stay plain.

const terminal = require("std/terminal");

/**
 * Colors a status code the morgan way: green 2xx, cyan 3xx, yellow
 * 4xx, red 5xx. Plain text when colors are disabled (piped output).
 * @param {number} status the response status
 * @param {boolean} color whether ANSI colors are enabled
 * @returns {string} the (possibly colored) status
 */
function colorStatus(status, color) {
  var text = String(status);
  if (!color) return text;
  if (status >= 500) return "\x1b[31m" + text + "\x1b[0m";
  if (status >= 400) return "\x1b[33m" + text + "\x1b[0m";
  if (status >= 300) return "\x1b[36m" + text + "\x1b[0m";
  return "\x1b[32m" + text + "\x1b[0m";
}

/**
 * Measures a response body for the log line: strings by length,
 * binary by byte length, anything else (unset, sent-as-JSON objects
 * already stringified by then) as missing.
 * @param {*} body the response body at log time
 * @returns {string} the length or `"-"`
 */
function bodyLength(body) {
  if (typeof body === "string") return String(body.length);
  if (body instanceof Uint8Array) return String(body.length);
  return "-";
}

/**
 * Builds a request-logging middleware.
 * @param {string} [format] `"dev"` (colored `METHOD url STATUS ms -
 *   length`, default), `"tiny"` (`METHOD url STATUS length - ms`),
 *   or `"combined"` (Apache-style with date, referrer, user agent)
 * @returns {Function} middleware (req, res, next)
 */
function logger(format) {
  if (format === undefined) format = "dev";
  if (format !== "dev" && format !== "tiny" && format !== "combined") {
    throw new Error("concarne.logger: format must be dev, tiny or combined");
  }
  return function loggerMiddleware(req, res, next) {
    var start = Date.now();
    next();
    var ms = Date.now() - start;
    var color = false;
    try {
      color = terminal.colorEnabled();
    } catch (e) {
      color = false;
    }
    var line;
    if (format === "combined") {
      line = req.ip + " - - [" + new Date().toUTCString() + "] \"" +
        req.method + " " + req.url + "\" " + res.statusCode + " " +
        bodyLength(res.body) + " \"" +
        (req.get("referrer") || req.get("referer") || "-") + "\" \"" +
        (req.get("user-agent") || "-") + "\"";
    } else if (format === "tiny") {
      line = req.method + " " + req.url + " " + res.statusCode + " " +
        bodyLength(res.body) + " - " + ms + " ms";
    } else {
      line = req.method + " " + req.url + " " +
        colorStatus(res.statusCode, color) + " " + ms + " ms - " +
        bodyLength(res.body);
    }
    console.log(line);
  };
}

module.exports = {logger: logger};
