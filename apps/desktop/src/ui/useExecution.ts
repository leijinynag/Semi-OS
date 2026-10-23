import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { parseApproval, parseExecution, type ExecutionSnapshot } from "./execution";

/** 先订阅再读取；读取中有新通知则补读，旧查询不能回退新事件。 */
export function useExecution(taskId: string) {
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let loading = false;
    let dirty = false;
    setSnapshot(undefined);
    setError("");
    const refresh = async () => {
      if (!active) return;
      if (loading) {
        dirty = true;
        return;
      }
      loading = true;
      try {
        do {
          dirty = false;
          const next = parseExecution(await invoke("get_task_execution", { taskId }), taskId);
          if (active) {
            setSnapshot(next);
            setError("");
          }
        } while (active && dirty);
      } catch {
        if (active) setError("执行记录读取失败，未将缺失结果视为成功");
      } finally {
        loading = false;
      }
    };
    const subscriptions = [
      listen<unknown>("host://task-execution", ({ payload }) => {
        if (payload === taskId) void refresh();
      }),
      listen<unknown>("host://research-confirmation", ({ payload }) => {
        try {
          if (parseApproval(payload).value.taskId === taskId) void refresh();
        } catch {
          if (active) setError("确认请求格式错误");
        }
      }),
      listen<unknown>("host://research-confirmation-expired", () => {
        void refresh();
      }),
    ];
    void Promise.all(subscriptions)
      .then(refresh)
      .catch(() => {
        if (active) setError("执行进度订阅失败");
      });
    return () => {
      active = false;
      for (const subscription of subscriptions)
        void subscription.then((stop) => stop()).catch(() => {});
    };
  }, [taskId]);
  return { snapshot: snapshot?.taskId === taskId ? snapshot : undefined, error };
}
