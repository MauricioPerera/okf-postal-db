// Test del CLI okf: sólo cubre parseCommand y usage (puras, sin I/O).
// No ejecuta serve/mcp (bloquearían el proceso al escuchar stdio/socket).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, usage } from "../bin/okf.js";

test("parseCommand: comando + sin rest", () => {
  assert.deepEqual(parseCommand(["serve"]), { command: "serve", rest: [] });
});

test("parseCommand: comando + argumento posicional", () => {
  assert.deepEqual(parseCommand(["verify", "data"]), { command: "verify", rest: ["data"] });
});

test("parseCommand: argv vacío -> help", () => {
  assert.deepEqual(parseCommand([]), { command: "help", rest: [] });
});

test("usage: lista los 5 subcomandos", () => {
  const text = usage();
  for (const cmd of ["serve", "mcp", "verify", "init", "help"]) {
    assert.match(text, new RegExp(`\\b${cmd}\\b`), `usage debe mencionar ${cmd}`);
  }
});