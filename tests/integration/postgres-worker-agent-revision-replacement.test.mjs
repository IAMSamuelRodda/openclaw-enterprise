import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxRevisionUnsupportedError } from "../../packages/occ/src/index.ts";
import {
  ComputeStopYieldedError,
  computeStopShouldYield,
} from "../../apps/controller/src/drivers/compute/operation-context.ts";
import { requiresPostgres } from "../helpers/postgres-backend-state.mjs";
import { waitFor } from "../helpers/wait-for.mjs";
import { createWorkerRevisionFixtures } from "../helpers/postgres-worker-revision-fixture.mjs";
import {
  assertWorkEnds,
  countingExclusiveCompute,
  denyDeploy,
  failingStop,
  proxiedIAM,
  refusals,
  refusedStopWaits,
  startRefusedCandidate,
} from "../helpers/postgres-worker-refused-candidate.mjs";

// Exclusive replacement and refused candidates: predecessor stops across pending passes and
// maintenance, refused and self-failed exclusive candidates, refused deployments on shared
// Compute, predecessors that come back after the sweep, and a refused wait's failed reads and a
// refusal lifted past the deadline. Worker health is in the -health sibling, and a refused
// candidate's stop and its wait in the -refused-stop and -refused-wait siblings; the lane runs
// the revision files at once. These files name the -replacement, -refused-stop and -refused-wait
// siblings only by suffix: CI Impact sends a test-only change to full CI when another file names
// that test.

const { setup, cleanup, revisionTest } = createWorkerRevisionFixtures(import.meta.url);
after(cleanup);

revisionTest(
  "exclusive replacement blocks overlap, supersedes old maintenance and recovers through a new revision",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-workspace", { executionMode: "dedicated" });
    const running = new Set();
    const prepared = [];
    let rejectStop = true;
    let stopFailures = 0;
    const compute = {
      ...fixture.compute,
      requiresStoppedPredecessors: () => true,
      async prepareRevision(revision) {
        // This Driver boundary represents a resource which cannot be held by
        // two revisions. PostgreSQL and the real worker own ordering and retries.
        assert.deepEqual(
          [...running].filter((id) => id !== revision.id),
          [],
        );
        running.add(revision.id);
        prepared.push(revision.id);
        return {
          ...(await fixture.compute.prepareRevision(revision)),
          ready: revision.revision !== 2,
        };
      },
      async stopRevision(revision) {
        if (rejectStop && running.has(revision.id)) {
          rejectStop = false;
          stopFailures += 1;
          throw new Error("resource release temporarily unavailable");
        }
        running.delete(revision.id);
      },
      async retireRevision(revision) {
        running.delete(revision.id);
      },
    };
    await fixture.start(compute, { convergenceTimeoutMs: 3_000 });
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    const replacement = await fixture.revision(owner, 2);
    await waitFor("replacement preparation after predecessor release", async () =>
      running.has(replacement.id) ? true : undefined,
    );
    assert.equal(stopFailures, 1);
    const firstPreparations = prepared.filter((id) => id === first.id).length;
    const maintenance = {
      id: first.id,
      idempotencyKey: `agent_revision:${first.id}:maintenance:${randomUUID()}`,
    };
    await fixture.state.transactWithQueue((_unit, queue) =>
      queue.enqueue({
        idempotencyKey: maintenance.idempotencyKey,
        namespaceId: fixture.namespace.id,
        agentId: owner.id,
        revisionId: first.id,
        actorId: fixture.actor.id,
        availableAt: new Date(0),
      }),
    );
    await fixture.work(maintenance, "succeeded");
    assert.equal(prepared.filter((id) => id === first.id).length, firstPreparations);
    await fixture.work(replacement, "failed_permanent");
    assert.deepEqual([...running], [replacement.id]);
    const recovery = await fixture.revision(owner, 3);
    await fixture.work(recovery, "succeeded");
    assert.deepEqual([...running], [recovery.id]);
    const current = await fixture.currentAgent(owner);
    assert.equal(current.activeRevisionId, recovery.id);
  },
  { timeout: 30_000 },
);

async function enqueueMaintenance(fixture, owner, revision) {
  const maintenance = {
    id: revision.id,
    idempotencyKey: `agent_revision:${revision.id}:maintenance:${randomUUID()}`,
  };
  await fixture.state.transactWithQueue((_unit, queue) =>
    queue.enqueue({
      idempotencyKey: maintenance.idempotencyKey,
      namespaceId: fixture.namespace.id,
      agentId: owner.id,
      revisionId: revision.id,
      actorId: fixture.actor.id,
      availableAt: new Date(0),
    }),
  );
  return maintenance;
}

revisionTest(
  "exclusive replacement stops each predecessor once across pending passes and maintenance",
  async (fixture) => {
    const owner = await fixture.agent("exclusive-sweep-once", { executionMode: "dedicated" });
    let pendingPasses = 4;
    const driver = countingExclusiveCompute(fixture, {
      ready: (revision) => revision.revision !== 2 || pendingPasses-- <= 0,
    });
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    const replacement = await fixture.revision(owner, 2);
    await fixture.work(replacement, "succeeded", 30_000);
    assert.ok(driver.preparations(replacement) >= 5, "the replacement must repeat pending passes");
    // Exactly one stop holds because the fixture lease (30 s) outlasts this pending
    // window; with a shorter lease the scheduled re-stop would add more.
    assert.equal(driver.count(first), 1, "pending passes must not repeat the predecessor stop");

    for (let index = 0; index < 2; index += 1) {
      await fixture.work(await enqueueMaintenance(fixture, owner, replacement), "succeeded");
    }
    assert.equal(driver.count(first), 1, "maintenance must not repeat the predecessor stop");

    const recovery = await fixture.revision(owner, 3);
    await fixture.work(recovery, "succeeded");
    assert.equal(driver.count(replacement), 1);
    assert.equal(driver.count(first), 1, "a recorded predecessor is skipped by later sweeps");
    assert.deepEqual([...driver.running], [recovery.id]);
  },
  { timeout: 60_000 },
);

// Finding 990: exclusive replacement stops the active revision before its candidate's first
// pass. On Kubernetes the candidate then took over the Agent's Gateway, so when a later pass
// refused it because its actor lost `deploy`, its Pods kept answering chat with a deployment
// OCC had rejected while the recorded active revision had no workload. A refused candidate is
// stopped before its failure is published. A runtime that failed by itself (here a held model
// probe) keeps its Pods for diagnosis on its version's Logs tab. Either way the pointer still
// names the stopped predecessor: OCC never rolls back, and recovery is a new revision.
// "unsupported" is a refusal thrown by the pass itself rather than decided by its observation.
// A candidate that missed the convergence deadline or exhausted its retries failed by itself too.
const selfFailures = {
  held: "RUNTIME_MODEL_PROBE_FAILED",
  late: "CONVERGENCE_DEADLINE_EXCEEDED",
  retried: "DEPENDENCY_UNAVAILABLE",
};
for (const { failure, stopFailures = 0, convergenceTimeoutMs, maxAttempts } of [
  { failure: "revoked" },
  // A failed stop must not publish the refusal with the candidate still running: the work
  // waits, repeats the refusal and the stop, and the refusal keeps its code.
  { failure: "revoked", stopFailures: 1 },
  { failure: "unsupported", stopFailures: 1 },
  // A stop outage outlasts the attempt budget (here 2) and the convergence deadline: ending the
  // work then would leave the refused candidate serving with nothing left to stop it.
  { failure: "revoked", stopFailures: 3, convergenceTimeoutMs: 2_000, maxAttempts: 2 },
  { failure: "held" },
  { failure: "late", convergenceTimeoutMs: 2_000 },
  { failure: "retried", maxAttempts: 2 },
]) {
  const refused = failure in refusals;
  test(
    `a ${failure} exclusive candidate ${refused ? "is stopped" : "stays for diagnosis"} when its deployment fails${stopFailures === 0 ? "" : ` after ${stopFailures} failed stops`}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context, maxAttempts === undefined ? {} : { maxAttempts });
      const events = [];
      const stop = failingStop({ limit: stopFailures });
      // The candidate's first pass starts its runtime but is not ready yet.
      const { owner, first, replacement, driver, admittedAt } = await startRefusedCandidate(
        fixture,
        `exclusive-failed-${failure}`,
        {
          refuse: failure,
          emit: (event) => events.push(event),
          stopRevision: stop.stopRevision,
          startOptions: convergenceTimeoutMs === undefined ? {} : { convergenceTimeoutMs },
        },
      );
      await fixture.work(replacement, "failed_permanent", 30_000);
      assert.equal(stop.failed.length, stopFailures);
      if (convergenceTimeoutMs !== undefined) {
        assert.ok(
          Date.now() - admittedAt > convergenceTimeoutMs,
          "the work outlasted the deadline",
        );
      }
      const result = await fixture.workResult(replacement);
      assert.equal(result.rows[0].reason_code, refusals[failure] ?? selfFailures[failure]);
      // A thrown pass forgets the sweep record, so the retry repeats the idempotent stop. A
      // refusal whose stop failed retries only that stop, without sweeping again (finding 1034).
      const predecessorStops =
        failure === "retried" || (failure === "unsupported" && stopFailures === 0) ? 2 : 1;
      assert.equal(driver.count(first), predecessorStops, "replacement stopped the predecessor");
      if (refused) {
        assert.equal(driver.count(replacement), 1, "the refused candidate is stopped once");
        assert.deepEqual([...driver.running], [], "nothing serves the Agent");
        const waited = events.filter(
          ({ event, workId, refusal }) =>
            event === "worker.completed" &&
            workId === replacement.idempotencyKey &&
            refusal === refusals[failure],
        );
        assert.deepEqual(
          waited.map(({ outcome, code }) => [outcome, code]),
          Array.from({ length: stopFailures }, () => ["pending", "REFUSED_CANDIDATE_STOP_PENDING"]),
        );
      } else {
        assert.equal(driver.count(replacement), 0, "the failed runtime stays for diagnosis");
        assert.deepEqual([...driver.running], [replacement.id]);
      }
      const active = await fixture.activePointer(owner);
      assert.equal(active.rows[0].active_revision_id, first.id);
      if (failure === "unsupported") {
        // The refused stop counts as a sweep: the next deployment does not repeat it within the
        // lease (30 s here). Only this refusal leaves the Agent deployable; revoked keeps its deny.
        const recovery = await fixture.revision(owner, 3);
        await fixture.work(recovery, "succeeded");
        assert.equal(driver.count(replacement), 1, "the next sweep skips the stopped candidate");
      }
    },
  );
}

// Finding 1016: without exclusive replacement (Kubernetes declares it only for dedicated
// Harnesses; Docker and SSH not at all) a refused candidate was never stopped. On a first
// deployment it is the Agent's only runtime: on Kubernetes its embedded Gateway Pod kept its model
// key, secret environment and private state until a later deployment, stop or delete. It is now
// stopped before the refusal is published, waiting on a failed stop like an exclusive candidate.
// Beside an active revision a refused candidate is left alone: on Kubernetes the active revision
// keeps serving, and an embedded candidate may own the Agent's shared Gateway route, which its stop
// would delete. The next deployment retires it. (On Docker the candidate's preparation already
// replaced the Agent's gateway container; that redeploy shape is tracked separately.) A refusal
// decided before the work's first preparation leaves Compute untouched; see the Secret Driver and
// ServiceAccount issuance refusals in postgres-worker-agent-revision.test.mjs. "revoked" refuses on
// the second pass, before Compute, so only the first pass's recorded evidence shows the candidate
// was prepared; "unsupported" is refused by Compute itself on the first pass, before any evidence.
const sharedRefusals = {
  revoked: "AUTHORIZATION_DENIED",
  unsupported: "SANDBOX_HARNESS_UNSUPPORTED",
};
for (const { declares, shape, stopFailures = 0, refusal = "revoked" } of [
  { declares: true, shape: "first" },
  { declares: true, shape: "first", stopFailures: 1 },
  { declares: true, shape: "redeploy" },
  { declares: false, shape: "first" },
  { declares: false, shape: "first", refusal: "unsupported" },
  { declares: false, shape: "redeploy" },
]) {
  const compute = declares ? "embedded Kubernetes-style" : "undeclared (Docker or SSH)";
  const code = sharedRefusals[refusal];
  test(
    `${refusal === "unsupported" ? "an" : "a"} ${refusal} ${shape === "first" ? "first deployment" : "redeploy"} on ${compute} Compute ${shape === "first" ? "is stopped" : "is not stopped"}${stopFailures === 0 ? "" : ` after ${stopFailures} failed stop`}`,
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context);
      const owner = await fixture.agent(`shared-${refusal}-${shape}-${declares}-${stopFailures}`);
      let candidateId;
      let candidatePasses = 0;
      let failedStops = 0;
      const running = new Set();
      const stops = new Map();
      const retires = new Map();
      const counted = (counts, revision) => counts.get(revision.id) ?? 0;
      const events = [];
      const effects = [];
      await fixture.start(
        {
          ...fixture.compute,
          async bindAgent(binding) {
            effects.push("bind");
            await fixture.compute.bindAgent?.(binding);
          },
          // Kubernetes declares exclusive replacement only for dedicated Harnesses.
          ...(declares
            ? { requiresStoppedPredecessors: (revision) => revision.harness.mode === "dedicated" }
            : {}),
          async prepareRevision(revision) {
            effects.push("prepare");
            running.add(revision.id);
            const observed = await fixture.compute.prepareRevision(revision);
            if (revision.id !== candidateId) {
              return observed;
            }
            candidatePasses += 1;
            if (refusal === "unsupported") {
              // Compute started the runtime, then refused the revision in the same pass.
              throw new SandboxRevisionUnsupportedError("SANDBOX_HARNESS_UNSUPPORTED", "test");
            }
            if (candidatePasses === 1) {
              // The actor loses deploy authority after the candidate's runtime started; the
              // worker's recheck on the next pass refuses the deployment.
              await denyDeploy(fixture, owner);
            }
            return { ...observed, ready: false };
          },
          async stopRevision(revision) {
            effects.push("stop");
            if (revision.id === candidateId && failedStops < stopFailures) {
              failedStops += 1;
              throw new Error("Kubernetes API temporarily unavailable");
            }
            stops.set(revision.id, counted(stops, revision) + 1);
            running.delete(revision.id);
          },
          async retireRevision(revision) {
            retires.set(revision.id, counted(retires, revision) + 1);
            running.delete(revision.id);
          },
        },
        { emit: (event) => events.push(event) },
      );
      let first;
      if (shape === "redeploy") {
        first = await fixture.revision(owner, 1);
        await fixture.work(first, "succeeded");
      }
      const candidate = await fixture.revision(owner, shape === "first" ? 1 : 2);
      candidateId = candidate.id;
      await assertWorkEnds(fixture, candidate, "failed_permanent", code);
      assert.equal(failedStops, stopFailures);
      const active = await fixture.activePointer(owner);
      if (shape === "first") {
        assert.equal(active.rows[0].active_revision_id, null);
        assert.equal(counted(stops, candidate), 1, "the refused first deployment is stopped once");
        assert.deepEqual([...running], [], "nothing runs for the Agent");
        // Like Agent stop and retirement, each try binds the Agent first, even when this pass
        // refused before Compute and never bound it.
        assert.ok(
          effects.every((effect, index) => effect !== "stop" || effects[index - 1] === "bind"),
          effects.join(","),
        );
        // A failed stop publishes nothing: the work waits and keeps the refusal's code.
        const waited = events.filter(
          ({ event, workId, refusal }) =>
            event === "worker.completed" && workId === candidate.idempotencyKey && refusal === code,
        );
        assert.deepEqual(
          waited.map(({ outcome, code }) => [outcome, code]),
          Array.from({ length: stopFailures }, () => ["pending", "REFUSED_CANDIDATE_STOP_PENDING"]),
        );
      } else {
        assert.equal(active.rows[0].active_revision_id, first.id);
        assert.equal(counted(stops, candidate), 0, "the refused redeploy is not stopped");
        assert.equal(counted(stops, first) + counted(retires, first), 0, "the predecessor serves");
        assert.ok(running.has(first.id), "the predecessor still runs");
      }
    },
  );
}

test(
  "a predecessor that comes back after the sweep is stopped again",
  { ...requiresPostgres, timeout: 60_000 },
  async (context) => {
    for (const { leaseDurationMs, label, returns } of [
      // A late Compute effect makes the next pass fail, which forgets the record.
      { leaseDurationMs: 30_000, label: "failed-pass", returns: 1 },
      // A late effect keeps the candidate pending until one lease has elapsed.
      { leaseDurationMs: 1_000, label: "lease-restop", returns: 1 },
      // It comes back again after that re-stop; the next one follows two leases later.
      { leaseDurationMs: 1_000, label: "repeated-restop", returns: 2 },
    ]) {
      const fixture = await setup(context, { leaseDurationMs });
      const owner = await fixture.agent(`exclusive-resurrection-${label}`, {
        executionMode: "dedicated",
      });
      let first;
      let resurrections = 0;
      const driver = countingExclusiveCompute(fixture, {
        async onPrepare(revision, overlap) {
          if (revision.revision !== 2) {
            return;
          }
          if (resurrections < returns && driver.count(first) > resurrections) {
            // Model a lost claim's late Compute write landing after each stop.
            resurrections += 1;
            driver.running.add(first.id);
          } else if (overlap.length > 0 && label === "failed-pass") {
            driver.running.delete(revision.id);
            throw new Error("predecessor still holds the exclusive resource");
          }
        },
      });
      await fixture.start(driver.compute);
      first = await fixture.revision(owner, 1);
      await fixture.work(first, "succeeded");
      const replacement = await fixture.revision(owner, 2);
      await fixture.work(replacement, "succeeded", 30_000);
      assert.equal(resurrections, returns);
      assert.equal(
        driver.count(first),
        returns + 1,
        `${label}: the returned predecessor is stopped again`,
      );
      assert.deepEqual([...driver.running], [replacement.id]);
      const current = await fixture.currentAgent(owner);
      assert.equal(current.activeRevisionId, replacement.id);
      await fixture.stop();
    }
  },
);

// Finding 1041: an error in a waiting pass's first reads (its resources, or the stored refusal
// itself) was recorded as an ordinary retry. It spent an attempt, and its evidence hid the stored
// refusal, so the next pass prepared the candidate again; at the attempt limit the work failed
// DEPENDENCY_UNAVAILABLE with the candidate running and the refusal lost. The pass now reads the
// stored refusal again and retries its stop. If that read fails too, the claim is left to lease
// recovery, which keeps the refusal.
test(
  "a refused candidate's wait survives failures reading its stored refusal",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    // Two attempts: on main the second failed read ended the work.
    const fixture = await setup(context, { maxAttempts: 2 });
    const events = [];
    let failedStops = 0;
    let stopping = false;
    let readFailures = 0;
    let injected = 0;
    const queue = fixture.PostgresWorkQueue.prototype;
    const findWorkAttempt = queue.findWorkAttempt;
    queue.findWorkAttempt = function (...args) {
      if (readFailures > 0 && new Error().stack.includes("readRefusalWait")) {
        readFailures -= 1;
        injected += 1;
        return Promise.reject(new Error("canceling statement due to statement timeout"));
      }
      return findWorkAttempt.apply(this, args);
    };
    try {
      const { replacement, driver } = await startRefusedCandidate(fixture, "refused-wait-read", {
        refuse: "unsupported",
        emit: (event) => events.push(event),
        stopRevision: () => {
          if (stopping) {
            return undefined;
          }
          failedStops += 1;
          return Promise.reject(new Error("Pods did not terminate before the deadline"));
        },
      });
      await waitFor("two failed refused stops", async () => (failedStops >= 2 ? true : undefined));
      // One failed read: the same pass reads the refusal again and retries the stop.
      let before = failedStops;
      readFailures = 1;
      await waitFor(
        "a failed read, then the stop retried",
        async () => (injected >= 1 && failedStops >= before + 1 ? true : undefined),
        30_000,
      );
      // Both reads fail: the pass leaves its claim, and lease recovery keeps the refusal.
      readFailures = 2;
      await waitFor(
        "two failed reads in one pass",
        async () => {
          const ended = await fixture.workResult(replacement);
          assert.equal(ended.rows[0].reason_code, null, "the wait ended");
          const left = events.some(
            ({ event, code, workId }) =>
              event === "worker.error" &&
              code === "WORKER_UNAVAILABLE" &&
              workId === replacement.idempotencyKey,
          );
          return injected >= 3 && left ? true : undefined;
        },
        30_000,
      );
      const claimed = await fixture.observerPool.query(
        "SELECT claim_token FROM occ.controller_work WHERE idempotency_key = $1 AND state = 'claimed'",
        [replacement.idempotencyKey],
      );
      assert.equal(claimed.rowCount, 1, "the failed pass left its claim");
      before = failedStops;
      await fixture.expireClaim(replacement, claimed.rows[0].claim_token);
      await waitFor(
        "the recovered wait retries the stop",
        async () => (failedStops >= before + 1 ? true : undefined),
        30_000,
      );
      stopping = true;
      await fixture.work(replacement, "failed_permanent", 30_000);
      const result = await fixture.workResult(replacement);
      assert.equal(result.rows[0].reason_code, "SANDBOX_HARNESS_UNSUPPORTED");
      assert.equal(driver.count(replacement), 1, "the refused candidate was stopped");
      assert.deepEqual([...driver.running], []);
      assert.equal(driver.preparations(replacement), 2, "no wait prepared the candidate again");
      const evidence = await fixture.observerPool.query(
        `SELECT details->>'reasonCode' AS code, details->>'refusal' AS refusal
           FROM occ.audit_events WHERE details->>'workId' = $1 ORDER BY occurred_at, id`,
        [replacement.idempotencyKey],
      );
      const codes = evidence.rows.map(({ code, refusal }) => `${code}:${refusal ?? ""}`);
      assert.ok(codes.includes("LEASE_EXPIRED:SANDBOX_HARNESS_UNSUPPORTED"), codes.join(" "));
      assert.ok(!codes.some((code) => code.startsWith("DEPENDENCY_UNAVAILABLE")), codes.join(" "));
    } finally {
      queue.findWorkAttempt = findWorkAttempt;
    }
  },
);

// Finding 1042: an authorization or backend refusal that lifted after the convergence deadline
// prepared its waiting candidate again, and the deadline then ended the work with that candidate
// running beside the stopped predecessor the active pointer still named. Past the deadline the
// lift now stops the candidate and publishes the deadline, waiting like a refusal if the stop
// fails.
test(
  "an authorization refusal lifted past the deadline stops its candidate",
  { ...requiresPostgres, timeout: 120_000 },
  async (context) => {
    const fixture = await setup(context);
    const events = [];
    let failedStops = 0;
    let lifted = false;
    let liftedAt = 0;
    let failedAfterLift = 0;
    let admitted = Infinity;
    let preparations;
    let scenario;
    scenario = await startRefusedCandidate(fixture, "refused-lifts-late", {
      refuse: "iam",
      emit: (event) => events.push(event),
      // On main the pass after the grant prepared it again, and it became ready too late.
      candidateReady: () => lifted && Date.now() - liftedAt > 1_500,
      stopRevision: () => {
        if (lifted && failedAfterLift >= 2) {
          return undefined;
        }
        failedStops += 1;
        if (lifted) {
          failedAfterLift += 1;
        } else if (failedStops >= 2 && Date.now() - admitted > 3_000) {
          // Granted during this pass's stop, after its denial: the next pass sees the grant.
          lifted = true;
          liftedAt = Date.now();
          preparations = scenario.driver.preparations(scenario.replacement);
        }
        return Promise.reject(new Error("Kubernetes API temporarily unavailable"));
      },
      startOptions: {
        convergenceTimeoutMs: 2_000,
        transformDrivers: proxiedIAM(async (iam, request) => {
          const decision = await iam.authorize(request);
          const denied =
            !lifted &&
            request.action === "deploy" &&
            scenario !== undefined &&
            scenario.driver.preparations(scenario.replacement) > 0;
          return denied ? { ...decision, allowed: false } : decision;
        }),
      },
    });
    const { owner, first, replacement, driver } = scenario;
    admitted = Date.now();
    await waitFor("the grant past the deadline", async () => (lifted ? true : undefined), 30_000);
    await waitFor(
      "a wait on the deadline",
      async () =>
        refusedStopWaits(events, replacement).some(
          ({ refusal }) => refusal === "CONVERGENCE_DEADLINE_EXCEEDED",
        )
          ? true
          : undefined,
      30_000,
    );
    const waiting = await fixture.deploymentStatus(owner, replacement);
    assert.equal(waiting.progress.lastAttempt.code, "REFUSED_CANDIDATE_STOP_PENDING");
    assert.equal(
      waiting.progress.lastAttempt.message,
      "Deployment missed its convergence deadline; stopping the candidate before recording the failure. The controller will retry.",
    );
    await fixture.work(replacement, "failed_permanent", 60_000);
    const result = await fixture.workResult(replacement);
    assert.equal(result.rows[0].reason_code, "CONVERGENCE_DEADLINE_EXCEEDED");
    assert.deepEqual(result.rows[0].result_data, { timeoutMs: 2_000 });
    assert.equal(driver.preparations(replacement), preparations, "not prepared after the grant");
    assert.equal(failedAfterLift, 2);
    assert.equal(driver.count(replacement), 1, "the candidate was stopped");
    assert.ok(!driver.running.has(replacement.id));
    assert.ok(!driver.running.has(first.id), "the sweep had stopped the predecessor");
    const active = await fixture.activePointer(owner);
    assert.equal(active.rows[0].active_revision_id, first.id);
    // The waits after the grant name the deadline they will publish.
    const waits = refusedStopWaits(events, replacement).map(({ refusal }) => refusal);
    const lateWaits = waits.slice(waits.indexOf("CONVERGENCE_DEADLINE_EXCEEDED"));
    assert.deepEqual(lateWaits, ["CONVERGENCE_DEADLINE_EXCEEDED", "CONVERGENCE_DEADLINE_EXCEEDED"]);
  },
);

// Finding 1090: on exclusive replacement (Kubernetes dedicated), a redeploy's stop of its
// predecessor held the serial worker for the predecessor Gateway's whole drain (up to about
// 340 s). That drain now yields to due Work like a stopped Agent's. This exclusive Compute
// simulates it: a running revision's Gateway drains for `drainMs` from its first stop call, the
// wait ends with ComputeStopYieldedError when the worker allows it, and the Harness stops only
// after the drain. `overlaps` records any preparation while another revision of the same Agent
// still has a Harness: the RWO workspace and Gateway SQLite volumes would be mounted twice.
// `busy` revisions never become ready, so their deployments keep Work due.
function drainingExclusiveCompute(fixture, { drainMs }) {
  const running = new Map();
  const busy = new Set();
  const prepared = [];
  const overlaps = [];
  const harnessStops = [];
  const drains = new Map();
  const pointers = new Set();
  const stopCalls = new Map();
  let yields = 0;
  const compute = {
    ...fixture.compute,
    requiresStoppedPredecessors: () => true,
    async prepareRevision(revision) {
      for (const [id, agentId] of running) {
        if (id !== revision.id && agentId === revision.agentId) {
          overlaps.push([revision.id, id]);
        }
      }
      running.set(revision.id, revision.agentId);
      prepared.push(revision.id);
      const observation = await fixture.compute.prepareRevision(revision);
      return busy.has(revision.id) ? { ...observation, ready: false } : observation;
    },
    async stopRevision(revision) {
      stopCalls.set(revision.id, (stopCalls.get(revision.id) ?? 0) + 1);
      if (!running.has(revision.id)) {
        return;
      }
      if (!drains.has(revision.id)) {
        drains.set(revision.id, Date.now() + drainMs);
      }
      while (Date.now() < drains.get(revision.id)) {
        const agent = await fixture.currentAgent({ id: revision.agentId });
        pointers.add(agent?.activeRevisionId ?? null);
        if (await computeStopShouldYield("gateway")) {
          yields += 1;
          throw new ComputeStopYieldedError(
            "The AgentRevision workload Pods are still terminating; other work is waiting.",
          );
        }
        await delay(100);
      }
      running.delete(revision.id);
      harnessStops.push(revision.id);
    },
    async retireRevision(revision) {
      running.delete(revision.id);
    },
  };
  return {
    compute,
    running,
    busy,
    prepared,
    overlaps,
    harnessStops,
    pointers,
    stopCalls: (revision) => stopCalls.get(revision.id) ?? 0,
    yields: () => yields,
  };
}

function runningFor(driver, owner) {
  return [...driver.running].filter(([, agentId]) => agentId === owner.id).map(([id]) => id);
}

function workPasses(events, work) {
  return events.filter(
    ({ event, workId }) => event === "worker.completed" && workId === work.idempotencyKey,
  );
}

/**
 * An exclusive Agent whose first revision serves, another Agent's deployment that keeps Work due,
 * and a redeploy whose first pass yields its predecessor stop. `drainMs` is the first revision's
 * Gateway drain.
 */
async function yieldedRedeploy(fixture, label, { drainMs }) {
  const owner = await fixture.agent(label, { executionMode: "dedicated" });
  const driver = drainingExclusiveCompute(fixture, { drainMs });
  const events = [];
  await fixture.start(driver.compute, {
    emit: (event) => events.push({ ...event, at: Date.now() }),
  });
  const first = await fixture.revision(owner, 1);
  await fixture.work(first, "succeeded");
  const busy = await fixture.revision(await fixture.agent(`${label}-busy`), 1);
  driver.busy.add(busy.id);
  const requestedAt = Date.now();
  const replacement = await fixture.revision(owner, 2);
  const yielded = await waitFor("the predecessor stop to yield", async () =>
    workPasses(events, replacement).find(({ code }) => code === "PREDECESSOR_STOP_YIELDED"),
  );
  return { owner, driver, events, first, busy, replacement, yielded, requestedAt };
}

revisionTest(
  "a redeploy's predecessor stop yields during its Gateway drain and the replacement starts after it",
  async (fixture) => {
    const { owner, driver, events, first, busy, replacement, yielded, requestedAt } =
      await yieldedRedeploy(fixture, "drain-predecessor", { drainMs: 6_000 });
    assert.equal(yielded.outcome, "pending");
    // Deployment status says what the replacement waits for.
    const waiting = await fixture.deploymentStatus(owner, replacement);
    assert.equal(waiting.progress.lastAttempt.code, "PREDECESSOR_STOP_YIELDED");
    // The other Agent's deployment runs while the replacement waits for the drain.
    await waitFor(
      "another Agent's pass while the replacement is deferred",
      async () =>
        events.some(
          ({ event, workId, at }) =>
            event === "worker.completed" && workId === busy.idempotencyKey && at > yielded.at,
        ) || undefined,
    );
    const done = await fixture.work(replacement, "succeeded", 30_000);
    // Bounded by the drain, not by full waits of its own; yields refund their attempt.
    assert.ok(Date.now() - requestedAt < 6_000 + 20_000, `${Date.now() - requestedAt} ms`);
    assert.ok(done.attempt_count <= 1, `attempts ${done.attempt_count}`);
    // Hard invariant: the replacement was prepared only after the predecessor's Harness stopped,
    // and the predecessor's stop resumed its drain rather than restarting it (one Harness stop).
    assert.deepEqual(driver.overlaps, []);
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.ok(driver.yields() >= 1);
    assert.ok(driver.prepared.indexOf(replacement.id) > driver.prepared.lastIndexOf(first.id));
    // While the drain yielded, the pointer still named the predecessor; then the replacement.
    assert.deepEqual([...driver.pointers], [first.id]);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, replacement.id);
    const passes = workPasses(events, replacement);
    assert.ok(passes.every(({ code }) => code !== "DEPENDENCY_UNAVAILABLE"));
    // The yields are throttled like a stopped Agent's, and the completion carries their count.
    assert.deepEqual(
      passes.map(({ code, stopYields }) => [code, stopYields]),
      [
        ["PREDECESSOR_STOP_YIELDED", 1],
        ["REVISION_ACTIVATED", driver.yields()],
      ],
    );
  },
);

revisionTest(
  "a newer deployment admitted while a predecessor stop is yielded supersedes it and starts last",
  async (fixture) => {
    const { owner, driver, first, replacement } = await yieldedRedeploy(
      fixture,
      "drain-predecessor-third",
      { drainMs: 8_000 },
    );
    const third = await fixture.revision(owner, 3);
    await Promise.all([
      fixture.work(third, "succeeded", 30_000),
      fixture.work(replacement, "succeeded", 30_000),
    ]);
    assert.equal(
      (await fixture.workResult(replacement)).rows[0].reason_code,
      "REVISION_SUPERSEDED",
    );
    // Nothing slipped in: the yielded replacement never started, and the newer revision started
    // only once the predecessor's Harness was gone.
    assert.deepEqual(driver.overlaps, []);
    assert.ok(!driver.prepared.includes(replacement.id), driver.prepared.join(","));
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.deepEqual(runningFor(driver, owner), [third.id]);
    assert.equal((await fixture.currentAgent(owner)).activeRevisionId, third.id);
  },
);

revisionTest(
  "a yielded redeploy superseded by a deployment refused before Compute finishes its predecessor stop",
  async (fixture) => {
    const { owner, driver, first, replacement } = await yieldedRedeploy(
      fixture,
      "drain-predecessor-handoff",
      { drainMs: 4_000 },
    );
    // The newer deployment is refused before its pass reaches the predecessor sweep.
    const refused = await fixture.revision(owner, 3, {
      harness: { ...fixture.productionHarness, mode: "dedicated", version: "0.0.0-unapproved" },
    });
    await assertWorkEnds(fixture, refused, "failed_permanent", "HARNESS_DESCRIPTOR_MISMATCH");
    await assertWorkEnds(fixture, replacement, "succeeded", "REVISION_SUPERSEDED");
    // The superseded work finished the stop it started, so no Harness is left without its
    // Gateway; nothing else would stop it until a later deployment, stop or delete.
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.deepEqual(runningFor(driver, owner), []);
    assert.ok(!driver.prepared.includes(replacement.id));
    assert.ok(!driver.prepared.includes(refused.id));
    assert.deepEqual(driver.overlaps, []);
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, first.id);
  },
);

revisionTest(
  "a redeploy refused while its predecessor stop is yielded finishes that stop before it fails",
  async (fixture) => {
    const { owner, driver, first, replacement } = await yieldedRedeploy(
      fixture,
      "drain-predecessor-refused",
      { drainMs: 4_000 },
    );
    // The deploying actor loses deploy; the next pass refuses the replacement.
    await denyDeploy(fixture, owner);
    await assertWorkEnds(fixture, replacement, "failed_permanent", "AUTHORIZATION_DENIED");
    // The predecessor whose Gateway was already removed is stopped before the failure is
    // published, as when its stop never yielded, so its Harness does not keep the workspace.
    assert.deepEqual(driver.harnessStops, [first.id]);
    assert.deepEqual(runningFor(driver, owner), []);
    assert.ok(!driver.prepared.includes(replacement.id));
    assert.deepEqual(driver.overlaps, []);
    // Nothing serves until a new revision activates; the pointer still names the predecessor.
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, first.id);
  },
);

revisionTest(
  "a redeploy refused before stopping its predecessor leaves the serving revision running",
  async (fixture) => {
    const owner = await fixture.agent("drain-predecessor-early", { executionMode: "dedicated" });
    const driver = drainingExclusiveCompute(fixture, { drainMs: 4_000 });
    await fixture.start(driver.compute);
    const first = await fixture.revision(owner, 1);
    await fixture.work(first, "succeeded");
    await denyDeploy(fixture, owner);
    const replacement = await fixture.revision(owner, 2);
    await assertWorkEnds(fixture, replacement, "failed_permanent", "AUTHORIZATION_DENIED");
    assert.equal(driver.stopCalls(first), 0, "the serving revision is not stopped");
    assert.ok(driver.running.has(first.id));
    assert.equal((await fixture.activePointer(owner)).rows[0].active_revision_id, first.id);
  },
);

// Finding 1107: a yielded redeploy whose worker crashes on its last attempt is not ended by lease
// recovery in SQL, which would leave the predecessor's Harness and workspace with no Gateway and
// nothing to stop them. Recovery grants one more attempt, and that pass finishes the stop.
for (const refused of [false, true]) {
  test(
    refused
      ? "a yielded redeploy refused on the extra attempt after its last claim expired finishes its predecessor stop"
      : "a yielded redeploy whose last claim expires gets one more attempt, which finishes its predecessor stop",
    { ...requiresPostgres, timeout: 60_000 },
    async (context) => {
      const fixture = await setup(context, { maxAttempts: 1 });
      const { owner, driver, first, replacement } = await yieldedRedeploy(
        fixture,
        `drain-predecessor-crash-${refused}`,
        { drainMs: 8_000 },
      );
      // The worker dies during the deployment's last (only) attempt; its claim expires.
      await fixture.stop();
      await fixture.observerPool.query(
        `UPDATE occ.controller_work
         SET state = 'claimed', attempt_count = 1,
           claim_token = COALESCE(claim_token, gen_random_uuid()),
           lease_expires_at = clock_timestamp() - interval '1 second'
         WHERE idempotency_key = $1`,
        [replacement.idempotencyKey],
      );
      const queue = new fixture.PostgresWorkQueue(fixture.observerPool, {
        leaseDurationMs: 30_000,
        maxAttempts: 1,
        random: () => 0,
      });
      await queue.recoverStale();
      const row = await fixture.observerPool.query(
        "SELECT state, attempt_count FROM occ.controller_work WHERE idempotency_key = $1",
        [replacement.idempotencyKey],
      );
      assert.deepEqual(row.rows[0], { state: "queued", attempt_count: 0 });
      if (refused) {
        await denyDeploy(fixture, owner);
      }
      await fixture.start(driver.compute);
      if (refused) {
        await assertWorkEnds(fixture, replacement, "failed_permanent", "AUTHORIZATION_DENIED");
      } else {
        await assertWorkEnds(fixture, replacement, "succeeded", "REVISION_ACTIVATED");
      }
      // Hard invariant: the predecessor's Harness stopped once, before anything prepared the
      // replacement, and no Harness is left without its Gateway.
      assert.deepEqual(driver.overlaps, []);
      assert.deepEqual(driver.harnessStops, [first.id]);
      assert.deepEqual(runningFor(driver, owner), refused ? [] : [replacement.id]);
      assert.equal(
        (await fixture.activePointer(owner)).rows[0].active_revision_id,
        refused ? first.id : replacement.id,
      );
    },
  );
}
