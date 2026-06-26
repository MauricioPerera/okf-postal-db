// Tests de src/gitlog.js: passthrough por defecto (sin GIT_COMMIT) y best-effort sin repo.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { commitData } from "../src/gitlog.js";

const TMP = join("test", "tmp-gitlog");
const SAVED_GIT_COMMIT = process.env.GIT_COMMIT;

before(async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
});

after(async () => {
  if (SAVED_GIT_COMMIT === undefined) delete process.env.GIT_COMMIT;
  else process.env.GIT_COMMIT = SAVED_GIT_COMMIT;
  await rm(TMP, { recursive: true, force: true });
});

test("sin GIT_COMMIT -> { skipped:true } y no toca disco", async () => {
  delete process.env.GIT_COMMIT;
  const r = await commitData("cualquier-dir-inexistente", "msg");
  assert.deepEqual(r, { skipped: true });
});

test("con GIT_COMMIT=true y sin repo -> no lanza, devuelve objeto", async () => {
  process.env.GIT_COMMIT = "true";
  // TMP existe pero NO es un repo git: git add / commit deben fallar y capturarse.
  const r = await commitData(TMP, "msg");
  assert.ok(r && typeof r === "object");
  assert.equal("skipped" in r, false);
  // No exigimos crear repo ni git instalado: solo que no rompe.
});