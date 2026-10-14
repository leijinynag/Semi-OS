import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { WorkflowPlan, AgentRun, WorkflowApplication } from "@semi-os/protocol";

const exec = promisify(execFile);
export interface Workspace {
  repository: string;
  path: string;
  branch: string;
  baselineCommit: string;
}
export class NeedsUserError extends Error {}
interface IntegrationJournal {
  revision: string;
  applied: string[];
  pending?: string;
}
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", ["-C", cwd, ...args], { maxBuffer: 2_097_152, timeout: 30_000 });
  return result.stdout.trim();
}

/** 只在应用专属目录创建 worktree；不重置源目录、不 push、不强删未交付工作区。 */
export class WorkspaceService {
  readonly #owned = new Map<string, Workspace>();
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  /** 重启后不能仅凭数据库路径取得写入权；与真实 Git 登记及专属目录双重核对。 */
  async restore(plan: WorkflowPlan, run: AgentRun): Promise<Workspace> {
    if (!run.workspace || !run.branch || !run.baselineCommit)
      throw new NeedsUserError("该尝试尚未建立工作区");
    const root = await realpath(this.directory);
    const path = await realpath(run.workspace);
    const distance = relative(root, path);
    if (distance !== run.runId || run.branch !== `codex/semi-os-${run.runId}`)
      throw new Error("workspace ownership mismatch");
    const repository = await realpath(plan.repository);
    const listing = await git(repository, ["worktree", "list", "--porcelain", "-z"]);
    const blocks = listing.split("\0\0").map((block) => block.split("\0"));
    const registered = blocks.some(
      (fields) =>
        fields.includes(`worktree ${path}`) && fields.includes(`branch refs/heads/${run.branch}`),
    );
    if (!registered) throw new Error("workspace is not registered to repository");
    const common = await realpath(
      await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    const expected = await realpath(
      await git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    );
    if (
      common !== expected ||
      (await git(path, ["rev-parse", "--verify", `${run.baselineCommit}^{commit}`])) !==
        run.baselineCommit
    )
      throw new Error("repository identity mismatch");
    const workspace = { repository, path, branch: run.branch, baselineCommit: run.baselineCommit };
    this.#owned.set(path, workspace);
    return workspace;
  }
  async inspect(plan: WorkflowPlan): Promise<{ repository: string; baselineCommit: string }> {
    const repository = await realpath(await git(plan.repository, ["rev-parse", "--show-toplevel"]));
    if (repository !== (await realpath(plan.repository)))
      throw new NeedsUserError("请选择 Git 仓库根目录");
    const dirty = await git(repository, ["status", "--porcelain"]);
    if (dirty && !plan.baselineCommit)
      throw new NeedsUserError("源仓库有未提交改动，请先处理或在计划中选择已提交基线");
    const baselineCommit = await git(repository, [
      "rev-parse",
      "--verify",
      `${plan.baselineCommit ?? "HEAD"}^{commit}`,
    ]);
    if (plan.baselineCommit && baselineCommit !== plan.baselineCommit)
      throw new Error("baseline mismatch");
    return { repository, baselineCommit };
  }
  async create(plan: WorkflowPlan, runId: string, baseline?: string): Promise<Workspace> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("invalid workspace identity");
    const inspected = await this.inspect(plan);
    const baselineCommit = baseline ?? inspected.baselineCommit;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baselineCommit))
      throw new Error("invalid workspace baseline");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(await realpath(this.directory), runId);
    const branch = `codex/semi-os-${runId}`;
    await git(inspected.repository, ["worktree", "add", "-b", branch, path, baselineCommit]);
    const workspace = { ...inspected, path, branch, baselineCommit };
    this.#owned.set(path, workspace);
    return workspace;
  }
  async deliver(path: string, message: string): Promise<string> {
    const workspace = this.#owned.get(path);
    if (!workspace) throw new Error("workspace is not owned by this execution service");
    const pendingPick = await git(path, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"]).catch(
      () => undefined,
    );
    if (pendingPick) {
      // 不能先 add 再问 Git 是否存在冲突：暂存本身会清除 unmerged 标记。
      const unresolved = await git(path, ["diff", "--name-only", "--diff-filter=U", "-z"]);
      for (const name of unresolved.split("\0").filter(Boolean)) {
        const text = await readFile(join(path, name), "utf8").catch(() => undefined);
        if (text === undefined || /^(<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(text))
          throw new NeedsUserError("整合冲突仍未解决，请明确处理并保留核对记录");
      }
      const journal = await this.#journal(path);
      if (!journal || journal.pending !== pendingPick)
        throw new NeedsUserError("整合记录与 Git 冲突状态不一致，请先核对");
      await git(path, ["add", "--all"]);
      // 冲突解决不能变成普通提交掩盖整合状态；只继续当前已有 cherry-pick。
      if (await git(path, ["diff", "--name-only", "--diff-filter=U"]))
        throw new NeedsUserError("整合冲突仍未解决");
      await git(path, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.editor=true",
        "cherry-pick",
        "--continue",
      ]);
      await this.#saveJournal(path, {
        revision: await git(path, ["rev-parse", "HEAD"]),
        applied: [...journal.applied, pendingPick],
      });
    }
    // -A 仅覆盖独立工作区，用户当前分支和已有工作目录完全不进入提交范围。
    await git(path, ["add", "--all"]);
    if (await git(path, ["diff", "--cached", "--name-only"])) {
      await git(path, ["-c", "core.hooksPath=/dev/null", "commit", "-m", message]);
    }
    return git(path, ["rev-parse", "HEAD"]);
  }
  async integrate(
    path: string,
    commits: string[],
  ): Promise<{ revision: string; conflict: boolean }> {
    if (!this.#owned.has(path)) throw new Error("integration workspace is not owned");
    let journal = (await this.#journal(path)) ?? {
      revision: await git(path, ["rev-parse", "HEAD"]),
      applied: [],
    };
    const revision = await git(path, ["rev-parse", "HEAD"]);
    if (journal.pending) {
      const pending = await git(path, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"]).catch(
        () => undefined,
      );
      if (pending === journal.pending) return { revision, conflict: true };
      throw new NeedsUserError("整合操作结果不确定，请核对后继续，不能重复 cherry-pick");
    }
    if (await git(path, ["status", "--porcelain"]))
      throw new NeedsUserError("整合工作区存在未提交修改，请先处理再整合");
    // 可追加解决性提交，但回退/改写整合历史会使 applied 日志失效，必须先对账。
    if (
      journal.revision !== revision &&
      !(await git(path, ["merge-base", "--is-ancestor", journal.revision, revision]).then(
        () => true,
        () => false,
      ))
    ) {
      throw new NeedsUserError("整合历史发生回退或改写，请先核对，不能沿用旧整合日志");
    }
    journal.revision = revision;
    for (const commit of commits) {
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit))
        throw new Error("invalid delivery revision");
      if (journal.applied.includes(commit)) continue;
      const included = await git(path, ["merge-base", "--is-ancestor", commit, "HEAD"]).then(
        () => true,
        () => false,
      );
      if (included) continue;
      const equivalent = await git(path, ["cherry", "HEAD", commit, `${commit}^`]).then(
        (output) => output === `- ${commit}`,
        () => false,
      );
      if (equivalent) continue;
      // 先保存待执行身份；崩溃窗口保留为待核对，不能自动重做可能已生效的操作。
      await this.#saveJournal(path, { ...journal, pending: commit });
      try {
        await git(path, ["-c", "core.hooksPath=/dev/null", "cherry-pick", commit]);
      } catch {
        const pending = await git(path, ["rev-parse", "--verify", "CHERRY_PICK_HEAD"]).catch(
          () => undefined,
        );
        if (pending !== commit) throw new NeedsUserError("整合失败且无明确冲突状态，需人工核对");
        return { revision: await git(path, ["rev-parse", "HEAD"]), conflict: true };
      }
      journal = {
        revision: await git(path, ["rev-parse", "HEAD"]),
        applied: [...journal.applied, commit],
      };
      await this.#saveJournal(path, journal);
    }
    return { revision: await git(path, ["rev-parse", "HEAD"]), conflict: false };
  }
  async #journal(path: string): Promise<IntegrationJournal | undefined> {
    const filename = `${path}.integration.json`;
    const text = await readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (text === undefined) return undefined;
    const value: unknown = JSON.parse(text);
    const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v);
    if (
      !value ||
      typeof value !== "object" ||
      !("revision" in value) ||
      !hash(value.revision) ||
      !("applied" in value) ||
      !Array.isArray(value.applied) ||
      !value.applied.every(hash) ||
      ("pending" in value && !hash(value.pending))
    )
      throw new NeedsUserError("整合日志损坏，需人工核对");
    return value as IntegrationJournal;
  }
  async #saveJournal(path: string, journal: IntegrationJournal): Promise<void> {
    // 日志位于应用专属目录，不进入成果提交；同工作区只由一个执行尝试写入。
    const filename = `${path}.integration.json`;
    await writeFile(`${filename}.tmp`, JSON.stringify(journal), { mode: 0o600 });
    await rename(`${filename}.tmp`, filename);
  }
  async revision(path: string): Promise<string> {
    if (!this.#owned.has(path)) throw new Error("workspace is not owned");
    if (await git(path, ["status", "--porcelain"]))
      throw new NeedsUserError("工作区有后续修改，旧测试与审查失效");
    return git(path, ["rev-parse", "HEAD"]);
  }
  async applicationTarget(
    path: string,
    revision: string,
  ): Promise<{ expectedRef: string; expectedHead: string }> {
    const workspace = this.#owned.get(path);
    if (!workspace || (await this.revision(path)) !== revision)
      throw new NeedsUserError("整合成果已改变，请重新验证");
    const repository = workspace.repository;
    if (await git(repository, ["status", "--porcelain", "--untracked-files=all"]))
      throw new NeedsUserError("源工作区有未提交改动，请先处理");
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (
        await git(repository, ["rev-parse", "--verify", marker]).then(
          () => true,
          () => false,
        )
      )
        throw new NeedsUserError("源工作区有未结束的 Git 操作");
    }
    for (const marker of ["rebase-merge", "rebase-apply", "sequencer"]) {
      const markerPath = await git(repository, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        marker,
      ]);
      if (
        await stat(markerPath).then(
          () => true,
          () => false,
        )
      )
        throw new NeedsUserError("源工作区有未结束的 Git 操作");
    }
    const expectedRef = await git(repository, ["symbolic-ref", "HEAD"]).catch(() => {
      throw new NeedsUserError("源工作区必须位于命名分支");
    });
    const expectedHead = await git(repository, ["rev-parse", "HEAD"]);
    if (
      !(await git(repository, ["merge-base", "--is-ancestor", expectedHead, revision]).then(
        () => true,
        () => false,
      ))
    )
      throw new NeedsUserError("源分支已经分叉，请手动整合，不自动合并");
    return { expectedRef, expectedHead };
  }
  async apply(request: WorkflowApplication): Promise<void> {
    const workspace = this.#owned.get(request.workspace);
    if (!workspace || workspace.repository !== (await realpath(request.repository)))
      throw new Error("application repository mismatch");
    const target = await this.applicationTarget(request.workspace, request.revision);
    if (target.expectedRef !== request.expectedRef || target.expectedHead !== request.expectedHead)
      throw new NeedsUserError("批准后源分支已变化，请重新核对");
    // 不执行 hooks、自动合并或 reset；只把已验证后代提交 fast-forward 到用户确认的分支。
    await git(workspace.repository, [
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--ff-only",
      "--no-edit",
      request.revision,
    ]);
    if (
      (await git(workspace.repository, ["symbolic-ref", "HEAD"])) !== request.expectedRef ||
      (await git(workspace.repository, ["rev-parse", "HEAD"])) !== request.revision ||
      (await git(workspace.repository, ["status", "--porcelain"]))
    )
      throw new NeedsUserError("应用后状态未确认，请核对，不自动重试");
  }
  async diff(path: string): Promise<string> {
    const workspace = this.#owned.get(path);
    if (!workspace) throw new Error("workspace is not owned");
    const tracked = await git(path, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      workspace.baselineCommit,
    ]);
    // git diff 不包含未跟踪文件；显式列出文件身份，不能把未提交的新文件显示成“无差异”。
    const untracked = await git(path, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const names = untracked
      .split("\0")
      .filter(Boolean)
      .map((name) => JSON.stringify(name));
    const output = [
      tracked,
      names.length ? `[未跟踪文件，尚未保存交付提交]\n${names.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return output.length > 64_000 ? `${output.slice(0, 64_000)}\n[Diff 已截断]` : output;
  }
  async clean(path: string): Promise<boolean> {
    const workspace = this.#owned.get(path);
    if (!workspace || (await git(path, ["status", "--porcelain"]))) return false;
    // 即使干净，未整合成果也保留。明确用户清理授权在后续接入，不自动删除。
    return false;
  }
}
