//! 解析 Agent Worker 所需的 Node 可执行文件。
//!
//! 为什么 Host 必须自己找 Node：打包后的客户端由 launchd 启动，继承的 PATH
//! 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，而 Node 几乎总是装在 Homebrew、nvm
//! 或 volta 的目录下。此前直接 spawn `node`，在终端里 `tauri dev` 一切正常，
//! 从 Dock 或 `open` 启动却每次都以 `No such file or directory (os error 2)`
//! 失败；失败只写进 `diagnostics/worker.jsonl`，用户看到的是「很多功能不太
//! 正常」，而不是一条可执行的错误。
//!
//! 因此这里按固定优先级解析绝对路径，并把探测过的位置写进错误信息交给界面
//! 显示。约束有两条：解析顺序必须确定（同一台机器每次结果一致），并且不回退
//! 到「反正先跑起来」——找不到 Node 就明确报告 Worker 未启动。

use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

/// 显式覆盖用的环境变量。允许写绝对路径，也允许写 PATH 中的名字。
pub const OVERRIDE: &str = "SEMI_OS_NODE";

/// 候选路径：顺序即优先级，重复项只保留首次出现。
///
/// 覆盖值排在最前，因为用户显式指定时必须生效；Homebrew 的两种前缀放在
/// 系统级路径之后，覆盖 Apple Silicon 与 Intel 的安装差异。
pub fn candidates(explicit: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Some(explicit) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(explicit));
    }
    for fixed in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/opt/node/bin/node",
        "/usr/local/opt/node/bin/node",
    ] {
        paths.push(PathBuf::from(fixed));
    }
    if let Some(home) = home {
        for relative in [
            ".volta/bin/node",
            ".asdf/shims/node",
            ".nodenv/shims/node",
            ".local/bin/node",
        ] {
            paths.push(home.join(relative));
        }
    }
    dedupe(paths)
}

/// nvm 为每个版本保留独立目录，没有稳定的 `node` 路径；按版本号从高到低
/// 尝试，保证同一环境下解析结果确定（目录遍历顺序本身并不稳定）。
pub fn nvm_candidates(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) else {
        return Vec::new();
    };
    let mut versions: Vec<(Vec<u64>, PathBuf)> = entries
        .filter_map(Result::ok)
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            (version_key(&name), entry.path().join("bin/node"))
        })
        .collect();
    versions.sort_by(|left, right| right.0.cmp(&left.0));
    dedupe(versions.into_iter().map(|(_, path)| path).collect())
}

/// 依次尝试候选路径、登录 shell 探测、PATH 扫描，全部失败才报错。
pub fn resolve() -> Result<PathBuf, String> {
    let explicit = env::var(OVERRIDE).ok();
    let home = env::var_os("HOME").map(PathBuf::from);
    let mut tried = candidates(explicit.as_deref(), home.as_deref());
    if let Some(home) = home.as_deref() {
        tried.extend(nvm_candidates(home));
    }
    if let Some(found) = tried.iter().find(|candidate| is_executable(candidate)) {
        return Ok(found.clone());
    }
    if let Some(found) = login_shell_node().or_else(path_node) {
        return Ok(found);
    }
    Err(failure_message(&tried))
}

/// 文件存在且可执行才算命中；目录不算，避免把 `node` 目录当成二进制。
pub fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

/// `/bin/sh -l` 只读取 `/etc/profile` 与 `/etc/paths.d`，看不到交互式
/// zsh/bash 配置里的 nvm 初始化；它兜住系统级安装，所以排在候选列表之后。
fn login_shell_node() -> Option<PathBuf> {
    let output = Command::new("/bin/sh")
        .args(["-lc", "command -v node"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8(output.stdout).ok()?.trim());
    if path.is_absolute() && is_executable(&path) {
        Some(path)
    } else {
        None
    }
}

fn path_node() -> Option<PathBuf> {
    let value = env::var_os("PATH")?;
    env::split_paths(&value)
        .map(|directory| directory.join("node"))
        .find(|candidate| is_executable(candidate))
}

fn failure_message(tried: &[PathBuf]) -> String {
    let shown = tried
        .iter()
        .take(3)
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("、");
    format!(
        "找不到 Node.js 可执行文件。已探测 {shown} 等 {} 处；请安装 Node，或设置 {OVERRIDE} 指向 node 的绝对路径后重启客户端。",
        tried.len()
    )
}

fn version_key(name: &str) -> Vec<u64> {
    name.split(|character: char| !character.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

fn dedupe(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut unique: Vec<PathBuf> = Vec::new();
    for path in paths {
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let directory = env::temp_dir().join(format!("semi-os-node-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).expect("创建临时目录");
        directory
    }

    #[test]
    fn the_override_comes_first_and_is_not_probed_twice() {
        let home = Path::new("/Users/example");
        let resolved = candidates(Some("/custom/bin/node"), Some(home));
        assert_eq!(resolved.first(), Some(&PathBuf::from("/custom/bin/node")));
        assert!(resolved.contains(&PathBuf::from("/opt/homebrew/bin/node")));
        assert!(resolved.contains(&home.join(".volta/bin/node")));
        let repeated = candidates(Some(" /opt/homebrew/bin/node "), Some(home));
        let hits = repeated
            .iter()
            .filter(|path| path.as_path() == Path::new("/opt/homebrew/bin/node"))
            .count();
        assert_eq!(hits, 1);
    }

    #[test]
    fn a_blank_override_falls_back_to_the_default_order() {
        let resolved = candidates(Some("   "), None);
        assert_eq!(
            resolved.first(),
            Some(&PathBuf::from("/opt/homebrew/bin/node"))
        );
    }

    #[test]
    fn is_executable_requires_the_executable_bit() {
        let directory = temp_dir("executable");
        let plain = directory.join("node");
        std::fs::write(&plain, b"#!/bin/sh\n").expect("写入文件");
        assert!(!is_executable(&plain));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755))
                .expect("设置权限");
            assert!(is_executable(&plain));
        }
        assert!(
            !is_executable(&directory.join("missing")),
            "不存在的文件不算命中"
        );
        assert!(!is_executable(&directory), "目录不算可执行文件");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn nvm_candidates_prefer_the_newest_version() {
        let home = temp_dir("nvm");
        for version in ["v9.11.2", "v26.8.1", "v10.0.0"] {
            let directory = home.join(".nvm/versions/node").join(version).join("bin");
            std::fs::create_dir_all(&directory).expect("创建版本目录");
            std::fs::write(directory.join("node"), b"").expect("写入文件");
        }
        let resolved = nvm_candidates(&home);
        assert_eq!(
            resolved.first(),
            Some(&home.join(".nvm/versions/node/v26.8.1/bin/node"))
        );
        assert_eq!(resolved.len(), 3);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn the_failure_message_names_the_override_and_the_probed_paths() {
        let message = failure_message(&[
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/local/bin/node"),
        ]);
        assert!(message.contains(OVERRIDE));
        assert!(message.contains("/opt/homebrew/bin/node"));
        assert!(message.contains('2'));
    }
}
