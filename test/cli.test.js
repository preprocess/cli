import assert from "node:assert/strict"
import test from "node:test"

import { run } from "../dist/index.js"

test("help succeeds", () => {
  assert.equal(run(["--help"]), 0)
})

test("unknown commands use the documented local error code", () => {
  assert.equal(run(["not-a-command"]), 2)
})

