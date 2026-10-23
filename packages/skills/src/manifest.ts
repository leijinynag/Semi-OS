export type SkillIsolation = "none" | "isolated_worktree";
export type SkillIndependence = "not_required" | "preferred" | "required";
export type SkillAuthorization = "user_approved_plan" | "host_policy" | "user_confirmation";

export interface SkillBudget {
  maxParallelRuns: number;
  maxReworkRounds: number;
  maxNoProgressTurns: number;
}

export interface SkillManifest {
  name: string;
  description: string;
  capabilities: readonly string[];
  isolation: SkillIsolation;
  independence: SkillIndependence;
  authorization: SkillAuthorization;
  successCriteria: readonly string[];
  budget: SkillBudget;
  requireUserOn: readonly string[];
}

export class SkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillManifestError";
  }
}

type Scalar = boolean | number | string;
type ParsedValue = Scalar | string[];

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SkillManifestError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SkillManifestError(`${field} must be a non-empty list`);
  }
  return value.map((item) => nonEmpty(item, field));
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SkillManifestError(`${field} must be a positive integer`);
  }
  return value;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scalar(value: string): Scalar {
  const parsed = unquote(value);
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  if (/^-?\d+$/.test(parsed)) return Number(parsed);
  return parsed;
}

/**
 * 这里只解析内置 Skill 使用的受限 front matter 子集。它不是 YAML 执行器，
 * 也不负责加载脚本或资源；详细正文仍交给 Pi 官方 ResourceLoader。
 */
function parseFrontMatter(
  source: string,
): Record<string, Scalar | string[] | Record<string, Scalar>> {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new SkillManifestError("Skill is missing front matter");
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new SkillManifestError("Skill front matter is not closed");

  const result: Record<string, ParsedValue | Record<string, Scalar>> = {};
  let listKey: string | undefined;
  let mapKey: string | undefined;
  const body = lines.slice(1, end);
  for (const [index, raw] of body.entries()) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.startsWith("- ")) {
      if (indent !== 2 || !listKey || mapKey) {
        throw new SkillManifestError(`invalid front matter list at line ${index + 2}`);
      }
      const value = result[listKey];
      if (!Array.isArray(value)) {
        throw new SkillManifestError(`invalid list field: ${listKey}`);
      }
      value.push(unquote(text.slice(2)));
      continue;
    }
    const separator = text.indexOf(":");
    if (separator <= 0) {
      throw new SkillManifestError(`invalid front matter at line ${index + 2}`);
    }
    const key = text.slice(0, separator).trim();
    const value = text.slice(separator + 1).trim();
    if (indent === 0) {
      if (result[key] !== undefined) {
        throw new SkillManifestError(`duplicate front matter field: ${key}`);
      }
      if (value === "") {
        const next = body
          .slice(index + 1)
          .find((candidate) => candidate.trim() !== "" && !candidate.trimStart().startsWith("#"));
        const nextText = next?.trim() ?? "";
        const nextIndent = next ? next.length - next.trimStart().length : undefined;
        if (nextIndent !== 2) {
          throw new SkillManifestError(
            `empty front matter field must contain a list or mapping: ${key}`,
          );
        }
        if (nextText.startsWith("- ")) {
          result[key] = [];
          listKey = key;
          mapKey = undefined;
        } else {
          result[key] = {};
          mapKey = key;
          listKey = undefined;
        }
      } else {
        result[key] = scalar(value);
        listKey = undefined;
        mapKey = undefined;
      }
      continue;
    }
    if (indent === 2 && mapKey) {
      const map = result[mapKey];
      if (!map || Array.isArray(map) || typeof map !== "object") {
        throw new SkillManifestError(`invalid map field: ${mapKey}`);
      }
      map[key] = scalar(value);
      continue;
    }
    throw new SkillManifestError(`unsupported front matter structure at line ${index + 2}`);
  }
  return result;
}

export function parseSkillManifest(source: string): SkillManifest {
  const raw = parseFrontMatter(source);
  const budget = raw.budget;
  if (!budget || Array.isArray(budget) || typeof budget !== "object") {
    throw new SkillManifestError("budget must be a mapping");
  }
  const getBudget = (key: string): unknown => budget[key];
  return {
    name: nonEmpty(raw.name, "name"),
    description: nonEmpty(raw.description, "description"),
    capabilities: stringList(raw.capabilities, "capabilities"),
    isolation: nonEmpty(raw.isolation, "isolation") as SkillIsolation,
    independence: nonEmpty(raw.independence, "independence") as SkillIndependence,
    authorization: nonEmpty(raw.authorization, "authorization") as SkillAuthorization,
    successCriteria: stringList(raw.successCriteria, "successCriteria"),
    budget: {
      maxParallelRuns: positiveInteger(getBudget("maxParallelRuns"), "budget.maxParallelRuns"),
      maxReworkRounds: positiveInteger(getBudget("maxReworkRounds"), "budget.maxReworkRounds"),
      maxNoProgressTurns: positiveInteger(
        getBudget("maxNoProgressTurns"),
        "budget.maxNoProgressTurns",
      ),
    },
    requireUserOn: stringList(raw.requireUserOn, "requireUserOn"),
  };
}

export function normalizeSkillManifest(source: string): SkillManifest {
  const manifest = parseSkillManifest(source);
  const validIsolation: readonly SkillIsolation[] = ["none", "isolated_worktree"];
  const validIndependence: readonly SkillIndependence[] = ["not_required", "preferred", "required"];
  const validAuthorization: readonly SkillAuthorization[] = [
    "user_approved_plan",
    "host_policy",
    "user_confirmation",
  ];
  if (!validIsolation.includes(manifest.isolation)) {
    throw new SkillManifestError(`unsupported isolation: ${manifest.isolation}`);
  }
  if (!validIndependence.includes(manifest.independence)) {
    throw new SkillManifestError(`unsupported independence: ${manifest.independence}`);
  }
  if (!validAuthorization.includes(manifest.authorization)) {
    throw new SkillManifestError(`unsupported authorization: ${manifest.authorization}`);
  }
  if (
    manifest.capabilities.includes("write:workspace:isolated") &&
    manifest.isolation !== "isolated_worktree"
  ) {
    throw new SkillManifestError("write:workspace:isolated requires isolated_worktree isolation");
  }
  return manifest;
}
