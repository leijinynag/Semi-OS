import { getModel, type Model } from "@earendil-works/pi-ai/compat";

export interface CloudLlmConfig {
  provider: string;
  model: string;
}

export const DEFAULT_CLOUD_LLM_CONFIG: Readonly<CloudLlmConfig> = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
};

export function readCloudLlmConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CloudLlmConfig {
  const provider = environment.SEMI_OS_LLM_PROVIDER?.trim();
  const model = environment.SEMI_OS_LLM_MODEL?.trim();
  if (!provider && !model) {
    // Semi-OS 需要稳定且低延迟的项目默认模型，不能隐式跟随用户全局 Pi
    // 配置，否则全局切换模型会让桌面助手的延迟和行为也随之漂移。
    return { ...DEFAULT_CLOUD_LLM_CONFIG };
  }
  if (!provider || !model) {
    throw new Error(
      "SEMI_OS_LLM_PROVIDER and SEMI_OS_LLM_MODEL must be configured together",
    );
  }
  return { provider, model };
}

/**
 * 使用 Pi 官方模型目录解析显式云模型。
 *
 * 凭证仍由 Pi 的 ModelRuntime 从 Worker 环境或其认证存储读取；这里只选择
 * provider/model，不把 API Key 放进产品协议，更不会暴露给 React。
 */
export function resolveCloudLlmModel(
  config: CloudLlmConfig,
): Model<any> {
  const model = getModel(config.provider as never, config.model as never);
  if (!model) {
    throw new Error(
      `Pi model is unavailable: ${config.provider}/${config.model}`,
    );
  }
  return model;
}
