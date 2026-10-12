import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assertNoSecretMaterial,
  createPluginDriverRealFixture,
} from "../helpers/plugin-driver-real.mjs";

// A ClawHub release compatible with the pinned runtime (OpenClaw 2026.9.8). Its
// integrity is the archive SHA-256 ClawHub publishes for this version, in the
// base64 form OpenClaw records for a ClawHub install.
const defaultRelease = {
  nativeId: "lobster",
  name: "Lobster",
  source: "clawhub",
  packageName: "@openclaw/lobster",
  version: "2026.9.7",
  integrity: "sha256-JcZWME9XIGfIGl8TZb+oeW2DyHqKNX+O3Y90W2lg40Q=",
  toolNames: ["lobster"],
};

function selectedRelease() {
  const raw = process.env.OCC_TEST_OPENCLAW_CLAWHUB_RELEASE;
  return raw === undefined || raw.trim() === "" ? defaultRelease : JSON.parse(raw);
}

test(
  "an Installation-approved ClawHub release installs at its admitted identity and runs in a normal Agent turn",
  {
    skip:
      process.env.OCC_TEST_PLUGIN_DRIVER_OPENCLAW_CLAWHUB_REAL === "1"
        ? false
        : "Set OCC_TEST_PLUGIN_DRIVER_OPENCLAW_CLAWHUB_REAL=1 with disposable k3d/PostgreSQL, an immutable runtime image and model credentials.",
    timeout: 900_000,
  },
  async (context) => {
    const release = selectedRelease();
    const pluginId = `occ-plugin:${release.nativeId}`;
    const [toolName] = release.toolNames;
    const turnMarker = `OPENCLAW_CLAWHUB_REAL_${randomUUID()}`;
    const outputMarker = `CLAWHUB_TOOL_OUTPUT_${randomUUID().replaceAll("-", "")}`;
    const prompt =
      process.env.OCC_TEST_OPENCLAW_CLAWHUB_PROMPT ??
      [
        // Lobster built-ins only: one item from commands.list, rendered as literal
        // text. No shell step, so nothing in it reads as OpenClaw's core exec tool.
        `Call the tool named "${toolName}" once with action "run" and pipeline: commands.list | head --n 1 | template --text '${outputMarker}'`,
        `Do not use any other tool. After it returns, include ${turnMarker} in your final answer.`,
      ].join("\n");
    const resultPattern = process.env.OCC_TEST_OPENCLAW_CLAWHUB_RESULT_EXPECT ?? outputMarker;

    // The administrator's approval is Installation configuration: the fixture writes
    // it into the Installation file the real API and worker load at startup.
    const fixture = await createPluginDriverRealFixture(context, {
      pluginDriverId: "occ-plugin",
      scenario: "openclaw",
      databaseUrl: process.env.OCC_TEST_PLUGIN_DRIVER_OPENCLAW_CLAWHUB_DATABASE_URL,
      pluginDriverConfiguration: { approvedPlugins: [release] },
      // The fixture's 1Gi default OOM-kills the gateway once lobster loads; the
      // harness topology suite uses the same 2Gi for an embedded gateway.
      gatewayMemoryLimit: "2Gi",
      // At 2 CPUs the gateway stays throttled for over a minute after ready on
      // slower hosts, so readiness flaps between the test's reads.
      gatewayCpuLimit: "4",
    });
    const agent = await fixture.createAgent({
      harnessId: "openclaw",
      executionMode: "embedded",
      name: `openclaw-clawhub-${randomUUID()}`,
    });
    const modelSecret = await fixture.bindOpenAIModelSecret(agent.id);

    const allowedPlugins = ["openai", release.nativeId];
    const configurationPath = `/namespaces/${fixture.namespaceId}/configurations/${agent.configurationId}`;
    const configuration = await fixture.request("GET", configurationPath);
    assert.equal(configuration.status, 200, JSON.stringify(configuration.error));
    const configured = await fixture.request("PATCH", configurationPath, {
      values: {
        ...configuration.data.values,
        plugins: { ...configuration.data.values.plugins, allow: allowedPlugins },
        tools: {
          ...configuration.data.values.tools,
          allow: ["read"],
          // OpenClaw 2026.9.8 puts plugin tools behind core exec (code mode, for
          // models that prefer it) or tool_call (Tool Search, on by default).
          // Turning both off gives the model lobster's own schema, so the
          // transcript records the plugin's own tool call.
          codeMode: { enabled: false },
          toolSearch: false,
        },
      },
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.error));

    // The Agent editor names the plugin by ID only; package, version and source
    // come from the Installation's approval.
    await fixture.selectPlugin(agent.id, {
      pluginId,
      enabled: true,
      toolDefaults: { approval: "none" },
    });

    const deployed = await fixture.deployAndWait(agent);
    assert.deepEqual(
      deployed.revision.plugins?.releases,
      { [pluginId]: release },
      "admission records the exact approved release with the revision.",
    );
    assert.deepEqual(
      deployed.status.warnings,
      [],
      "a verified ClawHub install deploys without a plugin warning.",
    );

    // The Pod installed this exact release from ClawHub, not npm and not a newer
    // version. Startup already refused readiness on any mismatch; read it back here.
    assert.deepEqual(await fixture.readOpenClawPluginInstall(agent, release.nativeId), {
      pluginId: release.nativeId,
      pluginVersion: release.version,
      source: "clawhub",
      clawhubPackage: release.packageName,
      version: release.version,
      integrity: release.integrity,
    });
    const policy = await fixture.readOpenClawPluginPolicy(agent, release.nativeId);
    assert.deepEqual(policy.plugins, { allow: allowedPlugins, enabled: true });
    assert.deepEqual(policy.tools.allow, ["read", release.nativeId]);

    const sessionKey = `agent:main:clawhub-proof-${randomUUID()}`;
    const content = await fixture.normalGatewayTurn({
      agent,
      gatewayPassword: deployed.gatewayPassword,
      sessionKey,
      prompt,
      expectedPatterns: [turnMarker],
      secrets: [modelSecret],
    });
    assertNoSecretMaterial(
      content,
      [modelSecret],
      "ClawHub plugin proof response must not expose model credentials.",
    );
    // Read the turn from the native transcript. assertSessionToolCallEvidence also
    // requires a systemPromptReport, which OpenClaw 2026.9.8 no longer writes to
    // session entries, so this test checks the transcript directly.
    const evidence = await fixture.readSessionToolEvidence(agent, {
      sessionKey,
      turnMarker,
      toolName,
      resultPattern,
    });
    assert.equal(evidence.exists, true, `${sessionKey} must have a persisted transcript.`);
    assert.equal(evidence.userMarkerSeen, true, "the transcript must include the request.");
    assert.equal(evidence.assistantMarkerSeen, true, "the transcript must include the reply.");
    assert.equal(evidence.assistantError, false, "the Agent turn must succeed.");
    // The output marker appears only in the tool's own result, so a model reply
    // alone cannot satisfy this check.
    const matched = evidence.calls.find((call) =>
      evidence.results.some(
        (result) =>
          result.toolCallId === call.id && result.isError === false && result.matchesResult,
      ),
    );
    const transcript = {
      calls: evidence.calls,
      results: evidence.results,
      observedToolNames: evidence.diagnostics.observedToolNames,
    };
    assert.ok(
      matched,
      `the turn must call ${toolName} with a successful result containing the output marker: ${JSON.stringify(transcript)}`,
    );
    assert.deepEqual(
      evidence.diagnostics.observedToolNames,
      [toolName],
      `the turn must call only ${toolName}, not core exec or tool_call: ${JSON.stringify(transcript)}`,
    );
  },
);
