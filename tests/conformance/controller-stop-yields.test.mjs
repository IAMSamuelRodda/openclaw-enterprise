import assert from "node:assert/strict";
import test from "node:test";

import {
  STOP_YIELD_LOG_INTERVAL_MS,
  StopYields,
  stopYieldRecheckMs,
} from "../../apps/controller/src/worker/stop-yields.ts";

// Findings 1093 and 1094: stops that yield during their Gateway drain (#2145) are rechecked on
// a faster-growing cadence, do not count as due Work for another draining stop, and log their
// first yield and then at most one a minute.

function clock(start = 1_000_000) {
  const now = { value: start };
  return { now, read: () => now.value };
}

test("a yielded stop is rechecked after 1 s, growing to 5 s by 50 s", () => {
  assert.equal(stopYieldRecheckMs(0), 1_000);
  assert.equal(stopYieldRecheckMs(-5_000), 1_000);
  assert.equal(stopYieldRecheckMs(10_000), 1_000);
  assert.equal(stopYieldRecheckMs(20_000), 2_000);
  assert.equal(stopYieldRecheckMs(35_000), 3_500);
  assert.equal(stopYieldRecheckMs(50_000), 5_000);
  assert.equal(stopYieldRecheckMs(315_000), 5_000);
  assert.equal(stopYieldRecheckMs(900_000), 5_000);
  // Faster than the readiness cadence (age / 40), which is still at 1 s at 40 s.
  assert.ok(stopYieldRecheckMs(40_000) > 1_000);
  // A 315 s drain takes about 80 passes when every recheck yields, not about 125.
  let passes = 0;
  for (let at = 0; at < 315_000; at += stopYieldRecheckMs(at)) {
    passes += 1;
  }
  assert.ok(passes <= 85, `${passes} passes`);
});

test("a stop's first yield is logged, then at most one a minute with the count", () => {
  const { now, read } = clock();
  const yields = new StopYields(read);
  assert.equal(yields.yielded("stop-a"), 1);
  now.value += 1_000;
  assert.equal(yields.yielded("stop-a"), undefined);
  now.value += STOP_YIELD_LOG_INTERVAL_MS - 1_001;
  assert.equal(yields.yielded("stop-a"), undefined);
  now.value += 1;
  assert.equal(yields.yielded("stop-a"), 4);
  now.value += 5_000;
  assert.equal(yields.yielded("stop-a"), undefined);
  now.value += STOP_YIELD_LOG_INTERVAL_MS;
  assert.equal(yields.yielded("stop-a"), 6);
  // Another stop is logged on its own schedule.
  assert.equal(yields.yielded("stop-b"), 1);
  assert.equal(yields.yielded("stop-b"), undefined);
});

test("only stops whose latest pass yielded are excluded from a draining stop's due Work", () => {
  const { now, read } = clock();
  const yields = new StopYields(read);
  assert.deepEqual(yields.waiting(), []);
  yields.yielded("stop-a");
  yields.yielded("revision-b");
  assert.deepEqual(yields.waiting().sort(), ["revision-b", "stop-a"]);
  // A pass that ends any other way (done, failed, retried) is due Work again, and its next
  // yield starts a new log series.
  yields.settled("stop-a");
  assert.deepEqual(yields.waiting(), ["revision-b"]);
  now.value += 1_000;
  assert.equal(yields.yielded("stop-a"), 1);
  yields.settled("unknown");
  assert.deepEqual(yields.waiting().sort(), ["revision-b", "stop-a"]);
});

test("a yielded stop this worker has not run for ten minutes is forgotten", () => {
  const { now, read } = clock();
  const yields = new StopYields(read);
  yields.yielded("stop-a");
  now.value += 300_000;
  yields.yielded("stop-b");
  now.value += 299_999;
  assert.deepEqual(yields.waiting().sort(), ["stop-a", "stop-b"]);
  now.value += 1;
  assert.deepEqual(yields.waiting(), ["stop-b"]);
  // Forgotten, its next yield is logged as a first one.
  assert.equal(yields.yielded("stop-a"), 1);
  now.value += 300_000;
  assert.deepEqual(yields.waiting(), ["stop-a"]);
});
