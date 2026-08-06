import { strict as assert } from "node:assert";
import { increment, reset } from "../src/shared-counter.ts";

reset();
assert.equal(increment("job"), 1);
assert.equal(increment("job"), 2);
