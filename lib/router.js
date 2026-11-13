// concarne router: method + path matching with :params and * wildcards,
// prefix-scoped middleware with next(), 4-arg error middleware by arity,
// mountable sub-routers with path stripping, and app.param() callbacks.
// Everything is synchronous: the runtime calls the serve handler and
// expects the response back, so async route handlers cannot work in v1.

const wrapRequest = require("./request.js").wrapRequest;
const createResponse = require("./response.js").createResponse;

/**
 * Escapes a path segment so it matches literally in the route regex.
 * @param {string} s the segment
 * @returns {string} the segment with regex metacharacters escaped
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a route path into a matcher. `:name` segments capture one
 * path part, `*` captures across slashes into numeric params, and a
 * trailing slash is always optional.
 * @param {string} path the route path, e.g. `"/users/:id"`
 * @returns {{regex: RegExp, keys: string[], wildcards: number,
 *   exact: string|undefined}} the matcher with `:param` names and
 *   the `*` count in order (`exact` set for static paths, which the
 *   dispatcher compares by string instead of regex)
 */
function compilePath(path) {
  if (path === "/") {
    return {regex: /^\/?$/, keys: [], wildcards: 0, exact: "/"};
  }
  var keys = [];
  var wildcards = 0;
  var parts = path.split("/").map(function (seg) {
    if (seg === "*") {
      wildcards++;
      return "(.*)";
    }
    if (seg[0] === ":") {
      keys.push(seg.slice(1));
      return "([^/]+)";
    }
    return escapeRegex(seg);
  });
  var compiled = {regex: new RegExp("^" + parts.join("/") + "/?$"),
    keys: keys, wildcards: wildcards};
  if (keys.length === 0 && wildcards === 0) {
    // Static routes skip the regex entirely: the dispatcher compares
    // strings instead (the trailing-slash form matches too, exactly
    // like the `/?$` suffix does).
    compiled.exact = path;
  }
  return compiled;
}

/**
 * Decodes one captured path part, tolerating the garbage browsers and
 * curl sometimes send: undecodable input survives verbatim instead of
 * throwing the whole request away.
 * @param {string} s the raw capture
 * @returns {string} the decoded (or original) part
 */
function decodeParam(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

/**
 * Decides whether a `use([path])` layer sees this request: `null` and
 * `"/"` match everything, otherwise the request path must equal the
 * layer path or sit below it (`"/api"` matches `"/api"` and below).
 * @param {string|null} layerPath the layer's mount path
 * @param {string} reqPath the request path
 * @returns {boolean} true when the layer runs for this request
 */
function matchPrefix(layerPath, reqPath) {
  if (layerPath === null || layerPath === "/") return true;
  return reqPath === layerPath || reqPath.slice(0, layerPath.length + 1) === layerPath + "/";
}

/**
 * Decides whether a route layer answers this method. `ALL` answers
 * everything, and `GET` routes also answer `HEAD` (the runtime strips
 * the body, so handlers stay identical).
 * @param {string} layerMethod the registered method (`"ALL"` for any)
 * @param {string} reqMethod the request method
 * @returns {boolean} true when the layer runs for this method
 */
function methodMatches(layerMethod, reqMethod) {
  if (layerMethod === "ALL") return true;
  if (layerMethod === reqMethod) return true;
  return reqMethod === "HEAD" && layerMethod === "GET";
}

/**
 * Answers an unmatched request. Runs only when nothing sent a
 * response, so apps always own a real 404 shape.
 * @param {object} req the concarne request
 * @param {object} res the concarne response
 * @returns {undefined}
 */
function defaultNotFound(req, res) {
  res.status(404).json({error: "Not Found", path: req.path});
}

/**
 * Answers an error that reached the end of the stack. Honors
 * `err.status`/`err.statusCode` (what `HttpError` sets), clamps
 * nonsense to 500, and never leaks the stack.
 * @param {*} err the thrown or forwarded error
 * @param {object} req the concarne request
 * @param {object} res the concarne response
 * @returns {undefined}
 */
function defaultError(req, res, err) {
  var status = (err && (err.status || err.statusCode)) || 500;
  if (typeof status !== "number" || status < 100 || status > 599) status = 500;
  var message = err && err.message ? err.message : String(err);
  res.status(status).json({error: message});
}

var ALLOW_ORDER = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/**
 * Lists the methods a path answers, for 405/OPTIONS responses. Only
 * top-level route layers are consulted: paths served from inside a
 * mounted Router miss here and fall through to the outer walk, so a
 * wrong-method request under a mount answers 404 rather than 405.
 * A registered `GET` implies `HEAD`; `ALL` implies every common
 * method. Layers compile on demand, so routes added after `listen`
 * are honored too.
 * @param {Array} stack the registered middleware/route layers
 * @param {string} path the request path
 * @returns {string[]|null} the allowed methods, or null when no route
 *   matches the path at all
 */
function allowedMethods(stack, path) {
  var seen = {};
  for (var i = 0; i < stack.length; i++) {
    var layer = stack[i];
    if (layer.type !== "route") continue;
    var comp = layer.compiled || (layer.compiled = compilePath(layer.path));
    if (!comp.regex.exec(path)) continue;
    if (layer.method === "ALL") {
      for (var a = 0; a < ALLOW_ORDER.length; a++) seen[ALLOW_ORDER[a]] = true;
    } else {
      seen[layer.method] = true;
      if (layer.method === "GET") seen["HEAD"] = true;
    }
  }
  var out = [];
  for (var k = 0; k < ALLOW_ORDER.length; k++) {
    if (seen[ALLOW_ORDER[k]]) out.push(ALLOW_ORDER[k]);
  }
  for (var name in seen) {
    if (Object.prototype.hasOwnProperty.call(seen, name) &&
        ALLOW_ORDER.indexOf(name) < 0) out.push(name);
  }
  return out.length > 0 ? out : null;
}

/**
 * Answers a request whose path is known but whose method is not: 405
 * JSON with an `Allow` header. `OPTIONS` to a known path answers 200
 * with `Allow` instead, so CORS preflights and probes work without an
 * explicit route (an explicit `app.options(path)` route still wins,
 * since it runs in the normal walk first).
 * @param {object} req the concarne request
 * @param {object} res the concarne response
 * @param {string[]} allow the methods from `allowedMethods`
 * @returns {undefined}
 */
function methodNotAllowed(req, res, allow) {
  res.set("Allow", allow.join(", "));
  if (req.method === "OPTIONS") {
    res.status(200).end("");
  } else {
    res.status(405).json({error: "Method Not Allowed"});
  }
}

/**
 * Flattens handler arrays one level at a time so `use(a, [b, c])` and
 * `get(p, [a, b], c)` both run `a`, `b`, `c` in order.
 * @param {Array} fns the (possibly nested) handler list
 * @returns {Function[]} the flat handler list
 */
function flattenFns(fns) {
  var out = [];
  for (var i = 0; i < fns.length; i++) {
    if (Array.isArray(fns[i])) {
      var inner = flattenFns(fns[i]);
      for (var j = 0; j < inner.length; j++) out.push(inner[j]);
    } else {
      out.push(fns[i]);
    }
  }
  return out;
}

/**
 * Runs one param callback list to completion. A callback that never
 * calls its `next` stalls the walk on purpose (same as Express): the
 * caller must check `res.sent` afterwards and treat a quiet return as
 * a stuck request.
 * @param {Function[]} list the callbacks for one param name
 * @param {object} req the concarne request
 * @param {object} res the concarne response
 * @param {*} value the matched param value
 * @param {string} name the param name
 * @returns {*} the error passed to `next(err)`, if any
 */
function runParamCallbacks(list, req, res, value, name) {
  var outcome = {called: false, err: undefined};
  function step(e) {
    outcome.called = true;
    outcome.err = e;
  }
  for (var i = 0; i < list.length && !outcome.called && !res.sent; i++) {
    try {
      list[i](req, res, step, value, name);
    } catch (e) {
      outcome.called = true;
      outcome.err = e;
    }
  }
  return outcome;
}

/**
 * Walks a layer stack against one request/response pair. Threading
 * mirrors the original dispatcher: one `next()` per layer, error
 * layers only while an error is in flight (cleared by a bare `next()`
 * from an error layer), throws becoming the in-flight error. Route
 * layers run their `param` callbacks (once per name+value per request,
 * tracked on a non-enumerable `req` cache shared across nested router
 * runs) before the handler. Mounted Routers (middleware whose `fn`
 * carries `__concarneRouter`) run their sub-stack inline with the
 * mount prefix stripped from `req.path` (accumulated in
 * `req.baseUrl`); a sub-stack miss restores the path and continues
 * the outer walk, a sub-stack error continues as the outer in-flight
 * error. `done(err)` fires only when the stack exhausts without a
 * response; a layer that neither sends nor calls `next()` stalls the
 * walk and `done` never fires, so the caller can answer 500 instead
 * of hanging.
 * @param {Array} stack the layers to walk
 * @param {{paramCallbacks: Object}} shared the `param` callbacks
 * @param {object} req the concarne request
 * @param {object} res the concarne response
 * @param {Function} done `done(err)` on exhaustion without a response
 * @returns {undefined}
 */
function runStack(stack, shared, req, res, done) {
  // Param-callback cache, created only when param callbacks exist:
  // the common no-`param()` walk skips the defineProperty entirely.
  // Nested router runs share it through the request (created by
  // whichever level needs it first).
  var hasParams = false;
  for (var pk in shared.paramCallbacks) {
    if (shared.paramCallbacks[pk] && shared.paramCallbacks[pk].length > 0) {
      hasParams = true;
      break;
    }
  }
  var cache = null;
  if (hasParams) {
    if (!Object.prototype.hasOwnProperty.call(req, "__concarneParams")) {
      Object.defineProperty(req, "__concarneParams", {
        value: {}, enumerable: false, writable: true
      });
    }
    cache = req.__concarneParams;
  }
  var idx = 0;
  var err = undefined;
  var clearOnNext = false;
  /**
   * Advances the walk: `next()` continues, `next(err)` switches to
   * error layers, and a bare `next()` from an error layer clears the
   * error back to normal dispatch. Runs at most one layer per call;
   * each layer re-enters via its own `next` to continue.
   * @param {*} e nothing, or the error to put in flight
   * @returns {undefined}
   */
  function next(e) {
    if (e !== undefined) {
      err = e;
      clearOnNext = false;
    } else if (clearOnNext) {
      err = undefined;
      clearOnNext = false;
    }
    while (idx < stack.length) {
      var layer = stack[idx++];
      if (layer.type === "middleware") {
        if (!matchPrefix(layer.path, req.path)) continue;
        if (layer.fn && layer.fn.__concarneRouter === true) {
          var mount = layer.fn.__concarneMount;
          mount.ensure();
          var sub = req.path;
          var prefix = "";
          if (layer.path !== null && layer.path !== "/") {
            prefix = layer.path;
            sub = req.path === layer.path ? "/" : req.path.slice(layer.path.length);
          }
          var savedPath = req.path;
          var savedBase = req.baseUrl;
          req.path = sub;
          req.baseUrl = savedBase + prefix;
          var subDone = false;
          var subErr = undefined;
          mount.run(req, res, function (se) {
            subDone = true;
            subErr = se;
          });
          req.path = savedPath;
          req.baseUrl = savedBase;
          if (res.sent) return;
          if (!subDone) return;
          if (subErr !== undefined) {
            err = subErr;
            clearOnNext = false;
          }
          continue;
        }
        if (err !== undefined) {
          if (!layer.isError) continue;
          clearOnNext = true;
          try {
            layer.fn(err, req, res, next);
          } catch (e2) {
            err = e2;
            clearOnNext = false;
            continue;
          }
          return;
        }
        if (layer.isError) continue;
        try {
          layer.fn(req, res, next);
        } catch (e2) {
          err = e2;
          continue;
        }
        return;
      }
      // route layer
      if (err !== undefined) continue;
      if (!methodMatches(layer.method, req.method)) continue;
      var comp = layer.compiled || (layer.compiled = compilePath(layer.path));
      var m;
      if (comp.exact !== undefined) {
        // Static route: string comparison instead of a regex exec.
        m = req.path === comp.exact ||
          (comp.exact !== "/" && req.path === comp.exact + "/") ? true : null;
      } else {
        m = comp.regex.exec(req.path);
      }
      if (!m) continue;
      var params = {};
      for (var k = 0; k < comp.keys.length; k++) {
        params[comp.keys[k]] = decodeParam(m[k + 1]);
      }
      for (var w = 0; w < comp.wildcards; w++) {
        params[String(w)] = decodeParam(m[comp.keys.length + w + 1]);
      }
      req.params = params;
      var cbs = shared.paramCallbacks;
      var failed = false;
      if (cache !== null && cbs) {
        for (var p = 0; p < comp.keys.length && !res.sent && !failed; p++) {
          var pname = comp.keys[p];
          var list = cbs[pname];
          if (!list) continue;
          var ckey = pname + "\0" + params[pname];
          if (cache[ckey]) continue;
          cache[ckey] = true;
          var outcome = runParamCallbacks(list, req, res, params[pname], pname);
          if (res.sent) return;
          if (!outcome.called) return;
          if (outcome.err !== undefined) {
            err = outcome.err;
            failed = true;
          }
        }
      }
      if (failed) continue;
      try {
        layer.fn(req, res, next);
      } catch (e2) {
        err = e2;
        continue;
      }
      return;
    }
    done(err);
  }
  next();
}

/**
 * Builds the request handler for a registered stack. Creates the
 * concarne `req`/`res` (wiring the `req.res`/`res.req` cross-refs the
 * way Express does, so `format` and `location("back")` can reach the
 * request), runs the walk, and owns the fallthrough: in-flight error
 * to `defaultError`, known-path-wrong-method to 405/`Allow`
 * (auto-200 for `OPTIONS`), otherwise the 404 shape. A stalled walk
 * (a layer that neither sent nor called `next()`) answers 500 rather
 * than hanging the connection, since every v1 handler is synchronous
 * and silence is always a bug.
 * @param {Array} stack the registered middleware/route layers
 * @param {Object} [paramCallbacks] the `param` callbacks by name
 * @param {Object} [opts] dispatch options: `{trustProxy?: boolean}`
 *   (proxied `ip`/`hostname`/`protocol` when true)
 * @returns {Function} `dispatch(rawReq)` answering the runtime's
 *   `{status, headers, body}` response
 */
function createDispatcher(stack, paramCallbacks, opts) {
  var shared = {paramCallbacks: paramCallbacks || {}};
  var trustProxy = !!opts && opts.trustProxy === true;
  return function dispatch(rawReq) {
    var req = wrapRequest(rawReq, {trustProxy: trustProxy});
    var res = createResponse();
    Object.defineProperty(req, "res", {
      value: res, enumerable: false, writable: true
    });
    Object.defineProperty(res, "req", {
      value: req, enumerable: false, writable: true
    });
    var doneCalled = false;
    var finalErr = undefined;
    runStack(stack, shared, req, res, function (e) {
      doneCalled = true;
      finalErr = e;
    });
    if (!res.sent) {
      if (!doneCalled) {
        defaultError(req, res, new Error(
          "Request stalled: a handler neither sent a response nor called next()"));
      } else if (finalErr !== undefined) {
        defaultError(req, res, finalErr);
      } else {
        var allow = allowedMethods(stack, req.path);
        if (allow !== null) {
          methodNotAllowed(req, res, allow);
        } else {
          defaultNotFound(req, res);
        }
      }
    }
    return res.toRuntime();
  };
}

/**
 * Compiles every route layer in a routing state. Idempotent: layers
 * added after a compile reset the flag via `attachRouting`, so the
 * next `listen` (or router run) recompiles.
 * @param {{stack: Array, compiled: boolean}} state the routing state
 * @returns {undefined}
 */
function ensureCompiled(state) {
  if (state.compiled) return;
  for (var i = 0; i < state.stack.length; i++) {
    if (state.stack[i].type === "route") {
      state.stack[i].compiled = compilePath(state.stack[i].path);
    }
  }
  state.compiled = true;
}

var ROUTE_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all"];

/**
 * Attaches the Express-shaped registration API (`use`, one method per
 * HTTP verb plus `all`, `route` chaining, `param`, app settings) onto
 * any target. Shared by the app factory and `createRouter` so both
 * spell routes the same way. `use([path, ]...fns)` registers prefix
 * middleware (4-arity functions become error middleware); verb methods
 * take `(path, ...handlers)` with nested arrays flattened, except
 * single-argument `get(name)`, which reads a setting the Express way;
 * `route(path)` returns a chainable registering per-verb handlers for
 * one path; `param(name|[names], fn)` registers `(req, res, next,
 * value, name)` callbacks run when a route carrying that `:name`
 * matches; `set(name[, value])` / `get(name)` / `enable(name)` /
 * `disable(name)` / `enabled(name)` / `disabled(name)` own the
 * settings bag (`"trust proxy"` is honored by the dispatcher;
 * anything else is yours to read).
 * @param {object|Function} target the app or router to extend
 * @param {{stack: Array, compiled: boolean, paramCallbacks: Object,
 *   settings: Object}} state the routing state the methods close over
 * @returns {object|Function} the target, for chaining
 */
function attachRouting(target, state) {
  /**
   * Registers prefix middleware. Arrays nest and flatten; anything
   * that is not a function throws.
   * @param {string|Function|Array} [path] mount path, or the first handler
   * @param {...Function} fns handlers (arrays flatten in order)
   * @returns {object|Function} the target, for chaining
   */
  target.use = function (path, fns) {
    if (typeof path === "function" || Array.isArray(path)) {
      fns = [path].concat(fns || []);
      path = null;
    } else if (typeof path !== "string") {
      throw new Error("concarne.use: path must be a string");
    } else if (path[0] !== "/") {
      throw new Error("concarne.use: path must start with \"/\"");
    } else if (Array.isArray(fns)) {
      fns = fns;
    } else {
      fns = fns === undefined ? [] : [fns];
    }
    var flat = flattenFns(fns);
    if (flat.length === 0) {
      throw new Error("concarne.use: handler is not a function");
    }
    for (var i = 0; i < flat.length; i++) {
      if (typeof flat[i] !== "function") {
        throw new Error("concarne.use: handler is not a function");
      }
      state.stack.push({
        type: "middleware",
        path: path,
        fn: flat[i],
        isError: flat[i].length === 4
      });
    }
    state.compiled = false;
    return target;
  };

  function addRoute(method, path, fns) {
    if (typeof path !== "string" || path === "" || path[0] !== "/") {
      throw new Error("concarne: route path must be a string starting with \"/\"");
    }
    var flat = flattenFns(fns);
    if (flat.length === 0) {
      throw new Error("concarne: route " + method + " " + path + " needs a handler");
    }
    for (var i = 0; i < flat.length; i++) {
      if (typeof flat[i] !== "function") {
        throw new Error("concarne: route handler is not a function");
      }
      state.stack.push({type: "route", method: method, path: path, fn: flat[i]});
    }
    state.compiled = false;
    return target;
  }

  for (var r = 0; r < ROUTE_METHODS.length; r++) {
    if (ROUTE_METHODS[r] === "get") continue;
    (function (verb) {
      var method = verb === "delete" ? "DELETE" : verb.toUpperCase();
      target[verb] = function (path) {
        return addRoute(method, path,
          Array.prototype.slice.call(arguments, 1));
      };
    })(ROUTE_METHODS[r]);
  }

  /**
   * Registers a GET route, or (single string argument, the Express
   * overload) reads an app setting. `app.get("/users", h)` routes;
   * `app.get("trust proxy")` answers the setting.
   * @param {string} path the route path, or the setting name
   * @param {...Function} fns the route handlers
   * @returns {object|Function|*} the target, or the setting value
   */
  target.get = function (path) {
    if (arguments.length === 1) {
      if (!state.settings) return undefined;
      return Object.prototype.hasOwnProperty.call(state.settings, path)
        ? state.settings[path]
        : undefined;
    }
    return addRoute("GET", path,
      Array.prototype.slice.call(arguments, 1));
  };

  /**
   * Writes a setting (`app.set("trust proxy", true)`), or with one
   * argument reads it back like `get(name)` does.
   * @param {string} name the setting name
   * @param {*} [value] the setting value
   * @returns {object|Function|*} the target, or the setting value
   */
  target.set = function (name, value) {
    if (!state.settings) state.settings = {};
    if (arguments.length === 1) {
      return Object.prototype.hasOwnProperty.call(state.settings, name)
        ? state.settings[name]
        : undefined;
    }
    state.settings[name] = value;
    return target;
  };

  /**
   * Enables a boolean setting (`app.enable("trust proxy")`).
   * @param {string} name the setting name
   * @returns {object|Function} the target, for chaining
   */
  target.enable = function (name) {
    if (!state.settings) state.settings = {};
    state.settings[name] = true;
    return target;
  };

  /**
   * Disables a boolean setting (`app.disable("trust proxy")`).
   * @param {string} name the setting name
   * @returns {object|Function} the target, for chaining
   */
  target.disable = function (name) {
    if (!state.settings) state.settings = {};
    state.settings[name] = false;
    return target;
  };

  /**
   * Answers whether a setting is exactly `true`.
   * @param {string} name the setting name
   * @returns {boolean} true when enabled
   */
  target.enabled = function (name) {
    return !!state.settings && state.settings[name] === true;
  };

  /**
   * Answers whether a setting is not exactly `true`.
   * @param {string} name the setting name
   * @returns {boolean} true when disabled or unset
   */
  target.disabled = function (name) {
    return !state.settings || state.settings[name] !== true;
  };

  /**
   * Starts a chainable route registration for one path: each verb
   * method registers its handlers and returns the chain, so
   * `app.route("/users").get(list).post(create)` reads as one route.
   * @param {string} path the route path
   * @returns {object} the chain with one method per verb
   */
  target.route = function (path) {
    if (typeof path !== "string" || path === "" || path[0] !== "/") {
      throw new Error("concarne: route path must be a string starting with \"/\"");
    }
    var chain = {};
    for (var i = 0; i < ROUTE_METHODS.length; i++) {
      (function (verb) {
        var method = verb === "delete" ? "DELETE" : verb.toUpperCase();
        chain[verb] = function () {
          addRoute(method, path,
            Array.prototype.slice.call(arguments));
          return chain;
        };
      })(ROUTE_METHODS[i]);
    }
    return chain;
  };

  /**
   * Registers param callbacks run (in registration order) when a
   * matched route carries that `:name`. Each runs once per
   * name+value per request; `next(value)`-style errors and throws
   * become the in-flight error.
   * @param {string|string[]} name the param name (or names), without `:`
   * @param {Function} fn `fn(req, res, next, value, name)`
   * @returns {object|Function} the target, for chaining
   */
  target.param = function (name, fn) {
    var names = Array.isArray(name) ? name : [name];
    if (typeof fn !== "function") {
      throw new Error("concarne.param: callback must be a function");
    }
    for (var i = 0; i < names.length; i++) {
      if (typeof names[i] !== "string" || names[i] === "") {
        throw new Error("concarne.param: name must be a non-empty string");
      }
      var key = names[i][0] === ":" ? names[i].slice(1) : names[i];
      if (!state.paramCallbacks[key]) state.paramCallbacks[key] = [];
      state.paramCallbacks[key].push(fn);
    }
    return target;
  };

  return target;
}

/**
 * Creates a mountable sub-router: the same registration API as the
 * app (`use`, verbs, `route`, `param`), usable as
 * `app.use("/api", router)`. The dispatcher strips the mount prefix
 * before running the sub-stack (`req.path` is the stripped path,
 * `req.baseUrl` accumulates the mount), restoring both afterwards. A
 * sub-stack miss continues the outer walk; routers nest.
 * @returns {Function} the router middleware with the routing API
 */
function createRouter() {
  var state = {stack: [], compiled: false, paramCallbacks: {}, settings: {}};
  function router(req, res, next) {
    throw new Error("concarne Router must be mounted via app.use([path], router)");
  }
  router.__concarneRouter = true;
  router.__concarneMount = {
    /**
     * Compiles the sub-stack routes. Runs on every dispatch until the
     * flag sticks, so routers work with zero setup.
     * @returns {undefined}
     */
    ensure: function () {
      ensureCompiled(state);
    },
    /**
     * Runs the sub-stack inline against the stripped request.
     * @param {object} req the concarne request (stripped path)
     * @param {object} res the concarne response
     * @param {Function} done `done(err)` on sub-stack exhaustion
     * @returns {undefined}
     */
    run: function (req, res, done) {
      runStack(state.stack, {paramCallbacks: state.paramCallbacks},
        req, res, done);
    }
  };
  return attachRouting(router, state);
}

module.exports = {
  compilePath: compilePath,
  createDispatcher: createDispatcher,
  createRouter: createRouter,
  attachRouting: attachRouting,
  ensureCompiled: ensureCompiled,
  allowedMethods: allowedMethods,
  runStack: runStack
};
