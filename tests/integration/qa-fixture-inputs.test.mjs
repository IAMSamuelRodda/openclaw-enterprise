import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { protectedText } from "../helpers/qa-secrets.mjs";

test("QA credentials require a private regular file and reject symlink substitution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qa-credential-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credential = join(directory, "credential");
  await writeFile(credential, " test-only-credential\n", { mode: 0o600 });
  assert.equal(await protectedText(credential, "test credential"), "test-only-credential");

  // A path replaced with a symlink must not redirect the credential read,
  // even when its target would pass the regular-file and permission checks.
  const link = join(directory, "substituted");
  await symlink(credential, link);
  await assert.rejects(protectedText(link, "test credential"), { code: "ELOOP" });
  await assert.rejects(protectedText(directory, "test credential"), /private regular file/);
  await chmod(credential, 0o644);
  await assert.rejects(protectedText(credential, "test credential"), /private regular file/);
  await chmod(credential, 0o600);
  await writeFile(credential, " \n");
  await assert.rejects(protectedText(credential, "test credential"), /must not be empty/);
});

test(
  "parallel QA stages publish complete outcomes, failures and timings",
  { timeout: 30_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "qa-report-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, "matrix.json");
    const reportModule = new URL("../helpers/qa-report.mjs", import.meta.url).href;
    // Exercise the real reporter under node:test, including failed subtests.
    // A shared writeFile without a serialized snapshot can lose concurrent rows
    // or leave a trailing fragment of the previous JSON document.
    const source = `
    import test from 'node:test';
    import { createQaReport } from ${JSON.stringify(reportModule)};
    const report = createQaReport(${JSON.stringify(output)}, { scope: 'full', concurrency: 4 });
    test('parallel report', { concurrency: 4 }, async (t) => {
      await Promise.all(Array.from({length: 20}, (_, i) =>
        report.stage(t, 'compose/Codex', 'stage-' + i, async () => {
          if (i === 2) throw new Error('blocked by unavailable test prerequisite');
          if (i === 7) throw new Error('expected assertion failure');
        }, 'scenario-' + i)
      ));
      await report.save();
    });
  `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
    let diagnostic = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        diagnostic += chunk;
      });
    }
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 1, diagnostic);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.scope, "full");
    assert.equal(report.concurrency, 4);
    assert.equal(report.outcomes.length, 20);
    assert.equal(new Set(report.outcomes.map((row) => row.scenario)).size, 20);
    for (let i = 0; i < 20; i += 1) {
      const row = report.outcomes.find((value) => value.stage === `stage-${i}`);
      assert.equal(row.cell, "compose/Codex");
      assert.equal(row.scenario, `scenario-${i}`);
      let expectedOutcome = "passed";
      if (i === 2) {
        expectedOutcome = "blocked";
      } else if (i === 7) {
        expectedOutcome = "failed";
      }
      assert.equal(row.outcome, expectedOutcome);
      assert.ok(Number.isFinite(Date.parse(row.startedAt)));
      assert.ok(Number.isInteger(row.durationMs) && row.durationMs >= 0);
    }
    assert.match(report.outcomes.find((row) => row.stage === "stage-2").reason, /blocked by/);
    assert.match(
      report.outcomes.find((row) => row.stage === "stage-7").reason,
      /expected assertion/,
    );
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["matrix.json"]);
  },
);

test("QA selection keeps prerequisite credentials and reports omitted coverage", async () => {
  const { selectQaMatrix, validateQaInputs } = await import("../helpers/qa-selection.mjs");
  const selected = selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui,calendar" });
  assert.equal(selected.scope, "partial:selected");
  assert.deepEqual(
    selected.cells.map(({ cell, scenarios }) => ({ cell, scenarios })),
    [
      { cell: "compose/OpenClaw", scenarios: ["model-ui"] },
      { cell: "compose/Codex", scenarios: ["model-ui", "calendar"] },
      { cell: "kubernetes/OpenClaw", scenarios: ["model-ui"] },
      { cell: "kubernetes/Codex", scenarios: ["model-ui", "calendar"] },
    ],
  );
  assert.deepEqual(selected.cells[1].unselected, ["git-full", "git-read", "slack"]);
  assert.deepEqual(selected.cells[0].notApplicable, ["calendar", "git-read", "slack"]);
  assert.throws(() => validateQaInputs(selected, {}), /OPENAI_KEY_FILE is required/);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "model-ui,typo" }),
    /invalid QA scenario/,
  );
  assert.throws(() => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "" }), /invalid QA scenario/);
  assert.throws(
    () => selectQaMatrix({ OCC_TEST_QA_SCENARIOS: "calendar", OCC_TEST_QA_PRESET: "OpenClaw" }),
    /not applicable/,
  );
  const calendar = selectQaMatrix({
    OCC_TEST_QA_SCENARIOS: "calendar",
    OCC_TEST_QA_INSTALLATION: "compose",
  });
  assert.ok(!calendar.requiredEnv.includes("OCC_TEST_QA_OPENAI_KEY_FILE"));
  assert.deepEqual(calendar.cells[0].scenarios, []);
  const openclaw = selectQaMatrix({ OCC_TEST_QA_PRESET: "OpenClaw" });
  assert.deepEqual(openclaw.cells[0].scenarios, ["model-ui", "git-full"]);
  assert.ok(!openclaw.requiredEnv.some((name) => /CODEX|SLACK|CALENDAR/.test(name)));
  const full = selectQaMatrix({});
  assert.equal(full.scope, "full");
  assert.ok(full.repository);
  assert.throws(
    () =>
      validateQaInputs(full, Object.fromEntries(full.requiredEnv.map((name) => [name, "fixture"]))),
    /explicit authorization/,
  );
});

test("hosted QA materializes only selected credentials and rejects missing selected inputs", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const script = new URL("../../scripts/ci/qa-matrix-credentials.mjs", import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), "qa-hosted-inputs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const githubEnv = join(directory, "github-env");
  const result = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    env: {
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      OCC_TEST_QA_SCENARIOS: "model-ui,calendar",
      OPENAI_API_KEY: "synthetic-model-key",
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",
      OCC_TEST_CODEX_CALENDAR_TOOL_NAME: "test.calendar.read",
      OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT: "email",
      // Even if a caller supplies unrelated credentials, do not write them.
      SLACK_APP_TOKEN: "unselected-secret",
      REPOSITORY_APP_KEY: "unselected-secret",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
  const privateDirectory = join(directory, "qa-matrix-credentials");
  assert.deepEqual((await readdir(privateDirectory)).sort(), ["codex", "openai"]);
  assert.equal(
    await protectedText(join(privateDirectory, "codex"), "Codex credential"),
    "synthetic-codex-token",
  );
  const exported = await readFile(githubEnv, "utf8");
  assert.match(exported, /OCC_TEST_QA_CODEX_TOKEN_FILE=/);
  assert.doesNotMatch(exported, /synthetic-|unselected-secret|SLACK|REPOSITORY/);
  await rm(privateDirectory, { recursive: true });
  await rm(githubEnv);
  const missing = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
    env: {
      RUNNER_TEMP: directory,
      GITHUB_ENV: githubEnv,
      OCC_TEST_QA_SCENARIOS: "calendar",
      CODEX_ACCESS_TOKEN: "synthetic-codex-token",
      OCC_TEST_CODEX_CALENDAR_RESULT_EXPECT: "email",
    },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /CALENDAR_TOOL_NAME is required/);
  await assert.rejects(readFile(githubEnv), { code: "ENOENT" });
});

test("QA command diagnostics retain the error while hiding generated and environment secrets", async () => {
  const { qaCommandFailureDetail, registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  registerQaSecret("generated-private-value");
  const output = qaCommandFailureDetail(
    "earlier detail\n".repeat(12) +
      "Docker service could not start: generated-private-value and process-private-value\nAuthorization: Bearer example-private-value\n",
    { PRIVATE_INPUT: "process-private-value" },
  );
  assert.match(output, /Docker service could not start/);
  assert.ok(output.split("\n").length <= 8);
  assert.doesNotMatch(
    output,
    /generated-private-value|process-private-value|example-private-value/,
  );
});

test("QA waits report the last observation when they time out", async () => {
  const { waitFor } = await import("../helpers/qa-utils.mjs");
  let observations = 0;
  let last;
  await assert.rejects(
    waitFor(
      "fake condition",
      async () => {
        observations += 1;
        last = { observation: observations, pods: ["runtime-0"] };
        return false;
      },
      200,
      { describe: () => JSON.stringify(last), interval: 5 },
    ),
    (error) => {
      assert.equal(
        error.message,
        `Timed out: fake condition; last observation: {"observation":${observations},"pods":["runtime-0"]}`,
      );
      return true;
    },
  );
  assert.ok(observations >= 2, "the wait observed more than once");
  // Without `describe` the message is unchanged; a failing `describe` keeps the timeout.
  await assert.rejects(
    waitFor("plain condition", async () => false, 10, { interval: 5 }),
    (error) => error.message === "Timed out: plain condition",
  );
  await assert.rejects(
    waitFor("broken describe", async () => false, 10, {
      interval: 5,
      describe: () => {
        throw new Error("no state");
      },
    }),
    (error) =>
      error.message === "Timed out: broken describe; last observation unavailable (no state)",
  );
  assert.equal(
    await waitFor("ready", async () => "value", 10, { describe: () => "unused" }),
    "value",
  );
});

test("a QA Agent stop timeout names the remaining Pods and keeps redacted platform logs", async () => {
  const { registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  const { stopQaAgent, describeStopObservation } = await import("../helpers/qa-repository.mjs");
  registerQaSecret("stop-fixture-service-key");
  const agent = { id: "agent-1", namespaceId: "namespace-1" };
  const pod = {
    metadata: {
      namespace: "oce-agent-1",
      name: "agent-1-gateway-0",
      deletionTimestamp: "2026-10-11T01:37:00Z",
      finalizers: ["openclaw.dev/runtime"],
      labels: { "openclaw.dev/agent": "agent-1", "openclaw.dev/workload-role": "gateway" },
    },
    spec: { containers: [{ env: [{ name: "GATEWAY_PASSWORD", value: "spec-private-value" }] }] },
    status: { phase: "Running" },
  };
  // A remaining Agent Pod whose log is not read, in the platform Namespace for the
  // Events de-duplication.
  const agentPod = {
    metadata: {
      namespace: "oce-system",
      name: "agent-1-runtime-0",
      labels: { "openclaw.dev/agent": "agent-1", "openclaw.dev/workload-role": "agent" },
    },
    status: { phase: "Running" },
  };
  // A rollout: two worker Pods, one restarted, and an API Pod.
  const platformPods = [
    {
      metadata: { name: "worker-a", labels: { "app.kubernetes.io/component": "worker" } },
      spec: { containers: [{ env: [{ name: "DATABASE_URL", value: "spec-private-value" }] }] },
      status: {
        phase: "Running",
        startTime: "2026-10-11T01:30:00Z",
        containerStatuses: [
          {
            name: "worker",
            restartCount: 1,
            lastState: {
              terminated: { reason: "Error", exitCode: 1, finishedAt: "2026-10-11T01:33:00Z" },
            },
          },
        ],
      },
    },
    {
      metadata: { name: "worker-b", labels: { "app.kubernetes.io/component": "worker" } },
      status: { phase: "Running", containerStatuses: [{ name: "worker", restartCount: 0 }] },
    },
    { metadata: { name: "api-a", labels: { "app.kubernetes.io/component": "api" } }, status: {} },
  ];
  const event = (time, name, message) => ({
    lastTimestamp: time,
    type: "Normal",
    reason: "Killing",
    involvedObject: { kind: "Pod", name },
    message,
  });
  const calls = [];
  const records = new Map();
  const f = {
    controlPlane: "kubernetes",
    env: {
      PRIVATE_INPUT: "launcher-private-value",
      OCC_DEVELOPMENT_COMPUTE_DRIVER: "kubernetes",
    },
    state: { platformNamespace: "oce-system" },
    async api(method, path) {
      calls.push(["api", method, path]);
      return method === "GET"
        ? { desiredRuntimeState: "stopped", activeRevisionId: "revision-1" }
        : undefined;
    },
    async kubectl(...args) {
      calls.push(["kubectl", ...args]);
      if (args[0] === "get") {
        return JSON.stringify({ items: [pod, agentPod] });
      }
      if (args.includes("deployment/openclaw-enterprise-worker")) {
        throw new Error("kubectl failed (exit 1); stderr: launcher-private-value unreachable");
      }
      const [verb, target] = args.slice(2);
      if (verb === "get" && target === "pods") {
        return JSON.stringify({ items: platformPods });
      }
      if (verb === "get" && target === "events") {
        return JSON.stringify({
          items: [
            event("2026-10-11T01:36:30Z", "agent-1-gateway-0", "Stopping; launcher-private-value"),
            event(undefined, "undated", "no time"),
            event("2026-10-11T01:30:00Z", "worker-a", "Started container worker"),
          ],
        });
      }
      if (args.includes("--previous")) {
        throw new Error("kubectl failed (exit 1); stderr: previous launcher-private-value gone");
      }
      if (target === "worker-a" || target === "worker-b") {
        return `2026-10-11T01:36:00Z ${target} worker.completed\n`;
      }
      if (target === "agent-1-gateway-0") {
        return (
          "2026-10-11T01:32:40Z draining active work before stop with timeout 315000ms: 1 active chat run(s)\n" +
          "2026-10-11T01:32:41Z assistant reply QA_NATIVE_conversation-text: drain the shutdown queue\n"
        );
      }
      return (
        "2026-10-11T01:36:00Z kubernetes compute: stop requested for agent-1\n" +
        "2026-10-11T01:36:01Z authenticated with stop-fixture-service-key\n" +
        "2026-10-11T01:36:02Z Authorization: Bearer abcdefghijklmnop\n"
      );
    },
    async record(name, value) {
      records.set(name, value);
      return `${this.controlPlane}-${name}.json`;
    },
  };
  await assert.rejects(stopQaAgent(f, agent, { timeout: 10 }), (error) => {
    assert.match(error.message, /^Timed out: ordinary Agent stop removes every runtime Pod; /);
    const observation = JSON.parse(
      /; last observation: (\{.*\}); API and worker logs: /.exec(error.message)[1],
    );
    assert.deepEqual(observation, {
      desiredRuntimeState: "stopped",
      activeRevisionId: "revision-1",
      pods: [
        {
          namespace: "oce-agent-1",
          name: "agent-1-gateway-0",
          phase: "Running",
          deletionTimestamp: "2026-10-11T01:37:00Z",
          finalizers: ["openclaw.dev/runtime"],
        },
        {
          namespace: "oce-system",
          name: "agent-1-runtime-0",
          phase: "Running",
          deletionTimestamp: null,
          finalizers: [],
        },
      ],
    });
    assert.match(
      error.message,
      /API and worker logs: kubernetes-agent-1-stop-timeout-platform-logs\.json$/,
    );
    assert.doesNotMatch(error.message, /spec-private-value/);
    return true;
  });
  assert.equal(agent.stopped, undefined);
  assert.deepEqual(calls[0], ["api", "POST", "/namespaces/namespace-1/agents/agent-1/stop"]);
  const logCall = calls.find((call) => call.includes("deployment/openclaw-enterprise-api"));
  assert.deepEqual(logCall.slice(1, 7), [
    "-n",
    "oce-system",
    "logs",
    "deployment/openclaw-enterprise-api",
    "--container",
    "api",
  ]);
  assert.ok(
    logCall.some((argument) => /^--tail=\d+$/.test(argument)),
    "the log tail is bounded",
  );
  const { logs } = records.get("agent-1-stop-timeout-platform-logs");
  assert.equal(logs.api[0], "2026-10-11T01:36:00Z kubernetes compute: stop requested for agent-1");
  assert.doesNotMatch(
    JSON.stringify(logs),
    /stop-fixture-service-key|abcdefghijklmnop|launcher-private-value/,
  );
  assert.equal(logs.api.length, 3);
  assert.match(logs.worker.unavailable.join("\n"), /unreachable/);
  assert.equal(describeStopObservation(undefined), "none");
  // During a rollout every worker Pod by name; only a restarted one's previous
  // container, whose failed read is kept, redacted.
  assert.deepEqual(logs.workerPods, {
    "worker-a": ["2026-10-11T01:36:00Z worker-a worker.completed"],
    "worker-b": ["2026-10-11T01:36:00Z worker-b worker.completed"],
  });
  assert.deepEqual(
    calls.filter((call) => call.includes("--previous")).map((call) => call.slice(1)),
    [
      [
        "-n",
        "oce-system",
        "logs",
        "worker-a",
        "--container",
        "worker",
        "--previous",
        "--timestamps",
        "--tail=600",
        "--request-timeout=30s",
      ],
    ],
  );
  assert.match(logs.workerPrevious["worker-a"].unavailable.join("\n"), /gone/);
  assert.deepEqual(logs.platformPods[0], {
    name: "worker-a",
    component: "worker",
    phase: "Running",
    startTime: "2026-10-11T01:30:00Z",
    deletionTimestamp: null,
    containers: [
      {
        name: "worker",
        restartCount: 1,
        lastTerminated: { reason: "Error", exitCode: 1, finishedAt: "2026-10-11T01:33:00Z" },
      },
    ],
  });
  // Events from the platform and each other remaining Namespace, oldest first.
  assert.deepEqual(Object.keys(logs.events), ["oce-system", "oce-agent-1"]);
  assert.deepEqual(
    logs.events["oce-agent-1"].map(({ object }) => object),
    ["Pod/undated", "Pod/worker-a", "Pod/agent-1-gateway-0"],
  );
  // Only the terminating Gateway's own drain messages; the Agent Pod's log is not read.
  assert.deepEqual(logs.gatewayDrain, {
    "agent-1-gateway-0": [
      "2026-10-11T01:32:40Z draining active work before stop with timeout 315000ms: 1 active chat run(s)",
    ],
  });
  assert.ok(!calls.some((call) => call.includes("agent-1-runtime-0")));
  assert.doesNotMatch(
    JSON.stringify(logs),
    /spec-private-value|QA_NATIVE_conversation-text|launcher-private-value/,
  );

  // A Compose control plane keeps the observation but has no in-cluster platform logs.
  records.clear();
  const composeAgent = { id: "agent-2", namespaceId: "namespace-1" };
  await assert.rejects(
    stopQaAgent({ ...f, controlPlane: "compose" }, composeAgent, { timeout: 10 }),
    (error) =>
      /; last observation: \{.*"pods":\[\{/.test(error.message) &&
      !/API and worker logs/.test(error.message),
  );
  assert.equal(records.size, 0);
});

test("QA log redaction hides each line of a registered multi-line secret", async () => {
  const { redactedQaTail, registerQaSecret } = await import("../helpers/qa-secrets.mjs");
  const body = ["MIIEfixtureLineOneAAAAAAAA", "fixtureLineTwoBBBBBBBBBBBB"];
  registerQaSecret(
    ["-----BEGIN PRIVATE KEY-----", ...body, "-----END PRIVATE KEY-----"].join("\n"),
  );
  const lines = redactedQaTail(
    `reading key\n${body[0]}\n${body[1]}\ndone\n`,
    {},
    {
      lines: 10,
      lineChars: 200,
    },
  );
  assert.deepEqual(lines[0], "reading key");
  assert.equal(lines.at(-1), "done");
  assert.doesNotMatch(lines.join("\n"), /fixtureLine/);
});
