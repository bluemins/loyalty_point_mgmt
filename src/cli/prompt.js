// Shared helpers for the command-line scripts: --flags and prompts.
const readline = require("readline");

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

// Created on first use, so a fully flag-driven run never waits on stdin.
let rl;
function reader() {
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return rl;
}

const ask = (question) => new Promise((resolve) => reader().question(question, (answer) => resolve(answer.trim())));

function askHidden(question) {
  const r = reader();
  return new Promise((resolve) => {
    const write = r._writeToOutput;
    r._writeToOutput = (text) => {
      if (text.includes(question)) write.call(r, text);
    };
    r.question(question, (answer) => {
      r._writeToOutput = write;
      r.output.write("\n");
      resolve(answer);
    });
  });
}

// The password comes from ADMIN_PASSWORD when set (for scripts), else is asked twice.
async function askPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const password = await askHidden("Password (min 10 characters): ");
  if ((await askHidden("Repeat password: ")) !== password) throw new Error("Passwords do not match");
  return password;
}

function closePrompts() {
  rl?.close();
}

module.exports = { flag, ask, askHidden, askPassword, closePrompts };
