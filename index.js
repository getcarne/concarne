// concarne: Express-like web framework for Carne.
// Pure JS on top of std/http: routing, middleware, parsed req, res helpers,
// static file serving with binary-safe bodies.
//
//   const concarne = require("pkg/concarne");
//   const app = concarne();
//   app.get("/users/:id", (req, res) => res.json({id: req.params.id}));
//   app.listen(3000);
//
// Handlers are synchronous in v1 (the runtime expects the response back
// from the serve handler, so async route handlers cannot work yet).

const http = require("std/http");
const routerLib = require("./lib/router.js");
const createDispatcher = routerLib.createDispatcher;
const ensureCompiled = routerLib.ensureCompiled;
const attachRouting = routerLib.attachRouting;
const createRouter = routerLib.createRouter;
const HttpError = require("./lib/request.js").HttpError;
const serveStatic = require("./lib/static.js").serveStatic;
const cors = require("./lib/cors.js").cors;
const rateLimit = require("./lib/ratelimit.js").rateLimit;
const bodyLib = require("./lib/body.js");
const logger = require("./lib/logger.js").logger;
const helmet = require("./lib/helmet.js").helmet;
const requestId = require("./lib/requestid.js").requestId;

/**
 * Creates an application: the Express-shaped registration API
 * (`use`, one method per verb plus `all`, `route` chaining, `param`)
 * with `listen`/`close` owning the `std/http` server. Routes compile
 * lazily on first listen so registration stays cheap.
 * @returns {object} the app
 */
function concarne() {
  var state = {stack: [], compiled: false, paramCallbacks: {}, settings: {}};

  var app = {
    /**
     * Serves the app: `listen(port[, host][, opts][, cb])`. `opts`
     * passes through to `http.serve` (`workers?`, `keepAliveMs?`,
     * `readTimeoutMs?`, `maxBodySize?`); `workers` (1..64, default 1)
     * serves from N full runtimes re-running the script, so gate
     * driver code (fetch/close/asserts) on `process.isWorker`.
     * @param {number} port the port to serve on
     * @param {string} [host] the interface to bind
     * @param {object} [opts] serve options (workers, timeouts, limits)
     * @param {Function} [cb] called with the `{port, host, workers}`
     *   server info once listening
     * @returns {{port: number, host: string, workers: number,
     *   close: Function}} the server handle
     */
    listen: function (port, host, opts, cb) {
      // listen(port[, host][, opts][, cb]): single (default) or multi
      // worker. opts passes through to http.serve: {workers?,
      // keepAliveMs?, readTimeoutMs?, maxBodySize?}. workers (1..64,
      // default 1) serves from N full runtimes re-running the script,
      // so gate driver code (fetch/close/asserts) on process.isWorker.
      var rest = Array.prototype.slice.call(arguments, 1);
      host = undefined;
      opts = undefined;
      cb = undefined;
      for (var i = 0; i < rest.length; i++) {
        var a = rest[i];
        if (typeof a === "function") {
          if (cb !== undefined) {
            throw new Error("concarne.listen: duplicate callback");
          }
          cb = a;
        } else if (typeof a === "string") {
          if (host !== undefined) {
            throw new Error("concarne.listen: duplicate host");
          }
          host = a;
        } else if (a !== null && typeof a === "object" && !Array.isArray(a)) {
          if (opts !== undefined) {
            throw new Error("concarne.listen: duplicate opts");
          }
          opts = a;
        } else if (a === undefined) {
          continue;
        } else {
          throw new Error("concarne.listen: bad argument #" + (i + 2));
        }
      }
      ensureCompiled(state);
      var handler = createDispatcher(state.stack, state.paramCallbacks,
        {trustProxy: state.settings["trust proxy"] === true});
      var srv;
      if (host === undefined && opts === undefined) {
        srv = http.serve(port, handler);
      } else if (host === undefined) {
        srv = http.serve(port, opts, handler);
      } else if (opts === undefined) {
        srv = http.serve(port, host, handler);
      } else {
        srv = http.serve(port, host, opts, handler);
      }
      var workers = (opts && typeof opts.workers === "number") ? opts.workers : 1;
      app._server = {port: srv.port, host: srv.host, workers: workers};
      if (cb) cb(app._server);
      return {
        port: srv.port,
        host: srv.host,
        workers: workers,
        close: function () { return app.close(); }
      };
    },
    /**
     * Stops the server. Safe to call when not listening.
     * @returns {boolean} true when a server was actually closed
     */
    close: function () {
      if (!app._server) return false;
      var ok = http.close(app._server.port);
      app._server = null;
      return ok;
    }
  };
  return attachRouting(app, state);
}

module.exports = concarne;
module.exports.HttpError = HttpError;
module.exports.Router = createRouter;
module.exports["static"] = serveStatic;
module.exports.cors = cors;
module.exports.rateLimit = rateLimit;
module.exports.json = bodyLib.json;
module.exports.urlencoded = bodyLib.urlencoded;
module.exports.logger = logger;
module.exports.helmet = helmet;
module.exports.requestId = requestId;
