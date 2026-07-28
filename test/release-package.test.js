import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createPackedTarball,
  verifyReleasePackage,
} from "./release-package.js";

test("the exact CLI tarball installs with the public v1 authoring toolchain", () => {
  const first = createPackedTarball();
  const second = createPackedTarball();
  assert.deepEqual(readFileSync(first), readFileSync(second));
  verifyReleasePackage(first);
});
