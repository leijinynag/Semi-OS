import readline from "node:readline";
import { decodeJsonl, encodeJsonl } from "../../../packages/protocol/src/envelope.ts";

// 运行真实协议边界，而非在测试里复制校验器；错误只回传稳定代码。
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  try {
    process.stdout.write(encodeJsonl(decodeJsonl(line)));
  } catch (error) {
    process.stdout.write(
      encodeJsonl({
        direction: "error",
        protocolVersion: 1,
        requestId: "req_contract_error",
        kind: "protocol.error",
        payload: {
          code: typeof error.code === "string" ? error.code : "invalid_message",
          message: "Contract message rejected",
          retryable: false,
        },
      }),
    );
  }
}
