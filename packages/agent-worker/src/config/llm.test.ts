import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLOUD_LLM_CONFIG,
  readCloudLlmConfig,
  resolveCloudLlmModel,
} from "./llm.ts";

test("uses the project DeepSeek Flash default instead of the global Pi model", () => {
  const config = readCloudLlmConfig({});

  assert.deepEqual(config, DEFAULT_CLOUD_LLM_CONFIG);
  assert.notEqual(config, DEFAULT_CLOUD_LLM_CONFIG);
});

test("allows an explicit provider and model to override the project default", () => {
  assert.deepEqual(
    readCloudLlmConfig({
      SEMI_OS_LLM_PROVIDER: "deepseek",
      SEMI_OS_LLM_MODEL: "deepseek-v4-pro",
    }),
    {
      provider: "deepseek",
      model: "deepseek-v4-pro",
    },
  );
});

test("rejects partial model overrides", () => {
  assert.throws(
    () =>
      readCloudLlmConfig({
        SEMI_OS_LLM_PROVIDER: "deepseek",
      }),
    /must be configured together/,
  );
  assert.throws(
    () =>
      readCloudLlmConfig({
        SEMI_OS_LLM_MODEL: "deepseek-v4-flash",
      }),
    /must be configured together/,
  );
});

test("resolves the default model through the Pi model catalog", () => {
  const model = resolveCloudLlmModel(readCloudLlmConfig({}));

  assert.equal(model.provider, "deepseek");
  assert.equal(model.id, "deepseek-v4-flash");
});
