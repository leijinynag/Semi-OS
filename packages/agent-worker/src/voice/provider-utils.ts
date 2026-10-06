export function combineAbortSignals(
  callerSignal: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error("provider request timed out")),
    timeoutMs,
  );
  const signal = AbortSignal.any([callerSignal, timeout.signal]);
  return {
    signal,
    dispose() {
      clearTimeout(timer);
    },
  };
}

export async function providerError(response: Response): Promise<Error> {
  // Provider 正文可能回显凭证、用户音频转写或请求参数，不能进入 Worker 日志
  // 和 React。诊断只保留 HTTP 状态；详细响应应在受控 Provider 遥测层处理。
  await response.body?.cancel().catch(() => undefined);
  return new Error(`provider request failed (${response.status})`);
}
