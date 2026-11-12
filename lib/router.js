// concarne router: method + path matching with :params and * wildcards,
// prefix-scoped middleware with next(), 4-arg error middleware by arity.
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
 * @returns {{regex: RegExp, keys: string[], wildcards: number}} the
 *   matcher with `:param` names and the `*` count in order
 */
function compilePath(path) {
  if (path === "/") {
    return {regex: /^\/?$/, keys: [], wildcards: 0};
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
  return {regex: new RegExp("^" + parts.join("/") + "/?$"), keys: keys, wildcards: wildcards};
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
function defaultError(err, req, res) {
  var status = (err && (err.status || err.statusCode)) || 500;
  if (typeof status !== "number" || status < 100 || status > 599) status = 500;
  var message = err && err.message ? err.message : String(err);
  res.status(status).json({error: message});
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
 * Builds the request handler for a registered stack. Walks layers in
 * order, threading one `next()` through them: middleware runs for its
 * prefix, routes run on method + path match, and 4-arity functions
 * only run once an error is in flight (they clear it by calling
 * `next()` bare, or replace it by calling `next(other)`). A throw
 * inside any layer becomes the in-flight error and dispatch continues
 * at the next layer, so one bad handler cannot kill the walk.
 * @param {Array} stack the registered middleware/route layers
 * @returns {Function} `dispatch(rawReq)` answering the runtime's
 *   `{status, headers, body}` response
 */
function createDispatcher(stack) {
  return function dispatch(rawReq) {
    // One request's walk state: idx resumes where the previous next()
    // left off, err carries the in-flight error, clearOnNext drops it
    // once an error layer hands control back to normal layers.
    var req = wrapRequest(rawReq);
    var res = createResponse();
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
        if (layer.method !== "ALL" && layer.method !== req.method) continue;
        var m = layer.compiled.regex.exec(req.path);
        if (!m) continue;
        var params = {};
        for (var k = 0; k < layer.compiled.keys.length; k++) {
          params[layer.compiled.keys[k]] = decodeParam(m[k + 1]);
        }
        for (var w = 0; w < layer.compiled.wildcards; w++) {
          params[String(w)] = decodeParam(m[layer.compiled.keys.length + w + 1]);
        }
        req.params = params;
        try {
          layer.fn(req, res, next);
        } catch (e2) {
          err = e2;
          continue;
        }
        return;
      }
      if (!res.sent) {
        if (err !== undefined) defaultError(err, req, res);
        else defaultNotFound(req, res);
      }
    }
    next();
    return res.toRuntime();
  };
}

module.exports = {
  compilePath: compilePath,
  createDispatcher: createDispatcher
};
