import { StructuredProvider, record, type ProviderStart } from "./provider.ts";
import { claudeConfiguration } from "./claude-config.ts";

/** 只映射已知失败类别，不把 CLI 原始 errors/result（可能包含认证信息）发往 Host/UI。 */
function failureMessage(message: Record<string, unknown>): string {
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((value): value is string => typeof value === "string")
    : [];
  const details = [...errors, typeof message.result === "string" ? message.result : ""].join("\n");
  if (/\b(401|403)\b|authentication|unauthorized|invalid.api.key/i.test(details))
    return "Claude 认证或访问权限失败，请检查本地配置";
  if (/\b429\b|rate.limit|too.many.requests/i.test(details))
    return "Claude 服务限流，本次执行未完成";
  if (/insufficient|credit.balance|quota.exceeded|billing/i.test(details))
    return "Claude 服务额度不足，本次执行未完成";
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch.failed|connection.error/i.test(details))
    return "Claude 网络连接失败，本次执行未完成";
  switch (message.subtype) {
    case "error_max_turns":
      return "Claude 已达到本次执行轮数上限，尚未交付完整结果";
    case "error_max_budget_usd":
      return "Claude 已达到本次执行预算上限，尚未交付完整结果";
    case "error_max_structured_output_retries":
      return "Claude 结构化输出未通过校验，本次执行未完成";
    default:
      return "Claude 执行失败，结果需核对；不能据此认定为认证问题";
  }
}

/** PreToolUse 每次调用都走 Host，不能仅拦截 CLI 尚未自动允许的 can_use_tool。 */
export class ClaudeCodingProvider extends StructuredProvider {
  readonly capabilities = { steer: false, pause: false, resume: true };
  start(input: ProviderStart): void {
    const configuration = claudeConfiguration(input.env ?? process.env);
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--safe-mode",
      "--restricted",
      "--strict-mcp-config",
      "--permission-mode",
      "manual",
      "--permission-prompt-tool",
      "stdio",
      "--tools",
      input.writing
        ? "Read,Glob,Grep,Write,Edit,Bash,AskUserQuestion"
        : "Read,Glob,Grep,AskUserQuestion",
    ];
    if (input.sessionId) args.push("--resume", input.sessionId);
    if (configuration.model && !configuration.env.ANTHROPIC_MODEL)
      args.push("--model", configuration.model);
    this.launch("claude", args, { ...input, env: configuration.env });
    this.process!.write({
      type: "control_request",
      request_id: "semi_init",
      request: {
        subtype: "initialize",
        hooks: { PreToolUse: [{ matcher: ".*", hookCallbackIds: ["semi_policy"] }] },
      },
    });
  }
  receive(message: Record<string, unknown>): void {
    if (message.type === "control_response") {
      const response = record(message.response);
      if (response.request_id === "semi_init") {
        if (response.subtype !== "success") {
          this.fail("Claude 未确认权限拦截能力");
          void this.stop();
          return;
        }
        this.process!.write({
          type: "user",
          session_id: "",
          parent_tool_use_id: null,
          message: { role: "user", content: this.input!.prompt },
        });
      }
    } else if (message.type === "control_request" && typeof message.request_id === "string") {
      const request = record(message.request);
      const id = message.request_id;
      const hook = request.subtype === "hook_callback" && request.callback_id === "semi_policy";
      const payload = hook ? record(request.input) : request;
      if (hook || request.subtype === "can_use_tool") {
        if (typeof payload.tool_name !== "string") throw new Error("invalid Claude permission");
        if (payload.tool_name === "AskUserQuestion") {
          // hook 不自行放行；让 CLI 的权限回调携带 questions，并回填主 Pi 的 answers。
          if (hook)
            this.process!.write({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: id,
                response: {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "ask",
                    permissionDecisionReason: "Semi-OS structured decision",
                  },
                },
              },
            });
          else void this.answerQuestion(id, record(payload.input));
          return;
        }
        void this.permission(
          {
            requestId: id,
            tool: payload.tool_name,
            input: record(hook ? payload.tool_input : payload.input),
          },
          (allowed) =>
            this.process!.write({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: id,
                response: hook
                  ? {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: allowed ? "allow" : "deny",
                        permissionDecisionReason: "Semi-OS Host policy",
                      },
                    }
                  : {
                      behavior: allowed ? "allow" : "deny",
                      ...(allowed
                        ? { updatedInput: payload.input }
                        : { message: "Semi-OS denied operation" }),
                    },
              },
            }),
        );
      } else
        this.process!.write({
          type: "control_response",
          response: { subtype: "error", request_id: id, error: "Unsupported control request" },
        });
    } else if (message.type === "system" && typeof message.session_id === "string") {
      this.input?.emit({ kind: "session", sessionId: message.session_id });
    } else if (message.type === "stream_event") {
      const event = record(message.event);
      const delta = record(event.delta);
      if (event.type === "content_block_delta" && delta.type === "text_delta")
        this.append(delta.text);
      if (event.type === "content_block_start") {
        const block = record(event.content_block);
        if (block.type === "tool_use")
          this.input?.emit({ kind: "activity", tool: String(block.name) });
      }
    } else if (message.type === "result") {
      if (message.is_error === true || message.subtype !== "success")
        this.fail(failureMessage(message));
      else this.complete(typeof message.result === "string" ? message.result : this.text);
    }
  }
  private async answerQuestion(id: string, input: Record<string, unknown>): Promise<void> {
    let value: Record<string, unknown> | null = null;
    try {
      value =
        (await this.input?.decision?.({ requestId: id, kind: "clarification", input })) ?? null;
    } catch {
      /* 不可靠或涉及用户意图时拒绝，并保留 Host 决策请求。 */
    }
    if (this.stopping) return;
    try {
      this.process!.write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: id,
          response: value
            ? { behavior: "allow", updatedInput: { ...input, answers: value.answers } }
            : {
                behavior: "deny",
                message: "This question requires human input; preserve the current work.",
              },
        },
      });
    } catch {
      this.fail("结构化问答回执发送失败");
    }
  }
  steer(): void {
    throw new Error("Claude 结构化流不支持可核验的轮中 steer；取消后恢复");
  }
  async pause(): Promise<void> {
    throw new Error("Claude 不支持原地暂停");
  }
}
