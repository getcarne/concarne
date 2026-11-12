// Shared test helper: check() throws on failure (uncaught -> exit 1).
// Passes print green, failures red (via std/terminal, which owns the
// NO_COLOR/TERM=dumb gate, so pipes keep colors like the CLI does).

const terminal = require("std/terminal");

/**
 * Asserts one test condition, printing a green `ok:` line. On failure
 * prints a red `failed:` line and throws, failing the run.
 * @param {boolean} cond the condition under test
 * @param {string} msg what passed or failed
 * @returns {undefined}
 */
function check(cond, msg) {
  if (!cond) {
    console.log(terminal.red("failed:") + " " + msg);
    throw new Error("failed: " + msg);
  }
  console.log(terminal.green("ok:") + " " + msg);
}

module.exports = {check: check};
