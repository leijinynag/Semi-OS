import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describePermissionOutcome,
  isRequestable,
  REQUESTABLE_PERMISSIONS,
  type PermissionRequestOutcome,
} from "./desktop-permission-request.ts";

test("only the closed permission set is requestable", () => {
  for (const permission of REQUESTABLE_PERMISSIONS) {
    assert.equal(isRequestable(permission), true, permission);
  }
  // 麦克风现在也在可请求集合内：TCC 只把发起过请求的进程列为可授权项。
  for (const rejected of ["", "accessibility ", "scripts", "Microphone"]) {
    assert.equal(isRequestable(rejected), false, rejected);
  }
});

test("every outcome explains the next step instead of claiming a refusal", () => {
  for (const permission of REQUESTABLE_PERMISSIONS) {
    const granted = describePermissionOutcome(permission, "granted");
    const requested = describePermissionOutcome(permission, "requested");
    assert.notEqual(granted, requested, permission);
    assert.match(granted, /已获得/, permission);
    // macOS 不暴露“用户拒绝”，所以未授权时必须引导到系统设置。
    assert.match(requested, /系统设置/, permission);
    assert.doesNotMatch(requested, /拒绝/, permission);
  }
  const outcomes: PermissionRequestOutcome[] = ["granted", "requested"];
  assert.equal(outcomes.length, 2);
});
