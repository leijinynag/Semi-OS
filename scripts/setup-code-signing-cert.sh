#!/usr/bin/env bash
#
# 创建本地自签代码签名证书，让 macOS TCC 授权在重建后依然有效。
#
# 为什么需要它：ad-hoc 签名（signingIdentity "-"）的 cdhash 每次重建都会变化，
# 而 TCC 把授权绑定到授予时的代码要求（cdhash）。于是每次重新构建，辅助功能、
# 输入监控、屏幕录制、麦克风四项授权全部失效，用户会看到“系统设置里明明打开了，
# 应用里还是未授权”。换成稳定证书后，TCC 匹配证书叶子而不是每次变化的哈希。
#
# 这个脚本会写入登录钥匙串并添加信任设置，因此必须由用户亲自执行：
# 过程中会要求输入登录钥匙串密码（用于解除私钥访问限制），可能还会要求管理员
# 授权以写入系统信任设置。脚本可重复执行，已存在同名身份时直接跳过。
#
# 用法：
#   bash scripts/setup-code-signing-cert.sh
#
# 完成后把 apps/desktop/src-tauri/tauri.conf.json 的
# bundle.macOS.signingIdentity 设为下面输出的身份名称。

set -euo pipefail

IDENTITY_NAME="${SEMI_OS_SIGNING_IDENTITY:-Semi-OS Local Signing}"
KEYCHAIN="${SEMI_OS_SIGNING_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() {
  printf '\n错误：%s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || fail "本脚本只在 macOS 上使用：代码签名证书是 macOS 的安全机制。"
command -v security >/dev/null || fail "找不到 security 命令，无法操作钥匙串。"

# 写信任设置会弹出系统认证对话框。用 perl 的 alarm 做硬超时，
# 避免无人看着屏幕时脚本永久挂死；超时按“未写入信任”处理。
semios_add_trust() {
  local cert="$1"
  perl -e 'alarm shift; exec @ARGV' 90 \
    security add-trusted-cert -r trustRoot -p codeSign \
    -k "$KEYCHAIN" "$cert" >/dev/null 2>&1
}

# 已经在钥匙串里则幂等退出，避免重复生成一堆同名证书。
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -Fq "\"$IDENTITY_NAME\""; then
  say "已存在签名身份：$IDENTITY_NAME"
  security find-identity -p codesigning "$KEYCHAIN" | grep -F "\"$IDENTITY_NAME\""
  printf '\n无需重复创建。可直接把 tauri.conf.json 的 signingIdentity 设为 "%s"。\n' "$IDENTITY_NAME"
  exit 0
fi

OPENSSL="$(command -v openssl || true)"
# macOS 自带 LibreSSL，-addext 行为不稳定；优先用 Homebrew 的 OpenSSL 3。
[ -x /opt/homebrew/bin/openssl ] && OPENSSL=/opt/homebrew/bin/openssl
[ -n "$OPENSSL" ] || fail "找不到 openssl。"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# 证书公钥保留在固定位置：临时目录会被清理，而写系统信任设置需要用文件路径。
CERT_EXPORT_DIR="$HOME/Library/Application Support/Semi-OS/signing"
CERT_EXPORT="$CERT_EXPORT_DIR/semi-os-local-signing.pem"

P12_PASSWORD="$(/usr/bin/openssl rand -hex 24)"

say "1/4 生成自签代码签名证书（有效期 10 年）"
cat >"$WORKDIR/openssl.cnf" <<'CONF'
[ req ]
distinguished_name = dn
prompt             = no
[ dn ]
CN = Semi-OS Local Signing
O  = Semi-OS
C  = CN
[ codesign ]
# CA:false——这是直接签名的终端证书，不是根 CA，避免把它当成可以给任意
# 代码背书的信任锚。keyUsage 只给 digitalSignature，codeSigning 是用途约束。
basicConstraints       = critical, CA:false
keyUsage               = critical, digitalSignature
extendedKeyUsage       = critical, codeSigning
subjectKeyIdentifier   = hash
CONF

# CN 由变量控制，所以写回配置里；其它字段保持常量。
/usr/bin/sed -i '' "s/^CN = .*/CN = $IDENTITY_NAME/" "$WORKDIR/openssl.cnf"

"$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -config "$WORKDIR/openssl.cnf" -extensions codesign \
  -keyout "$WORKDIR/key.pem" -out "$WORKDIR/cert.pem" 2>/dev/null ||
  fail "证书生成失败。"

say "2/4 打包为 PKCS#12 并导入登录钥匙串"
# 关键坑：OpenSSL 3 默认用 PBKDF2 + AES-256 + SHA256 MAC 输出 PKCS#12，
# 而 macOS 的 `security import` 只理解老式 PBE（RC2/3DES）与 SHA1 MAC，
# 直接导入会报 “MAC verification failed during PKCS12 import (wrong password?)”
# ——这个错误与密码无关，是格式不兼容。所以下面依次尝试兼容格式，
# 以“导入成功”作为唯一判据，而不是相信某个 flag 一定存在。
export_p12() {
  local mode="$1"
  case "$mode" in
    legacy)
      "$OPENSSL" pkcs12 -export -legacy \
        -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
        -name "$IDENTITY_NAME" -out "$WORKDIR/identity.p12" \
        -passout "pass:$P12_PASSWORD" >/dev/null 2>&1
      ;;
    pbe3des)
      "$OPENSSL" pkcs12 -export \
        -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
        -name "$IDENTITY_NAME" -out "$WORKDIR/identity.p12" \
        -passout "pass:$P12_PASSWORD" \
        -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 >/dev/null 2>&1
      ;;
    libressl)
      [ -x /usr/bin/openssl ] || return 1
      /usr/bin/openssl pkcs12 -export \
        -inkey "$WORKDIR/key.pem" -in "$WORKDIR/cert.pem" \
        -name "$IDENTITY_NAME" -out "$WORKDIR/identity.p12" \
        -passout "pass:$P12_PASSWORD" >/dev/null 2>&1
      ;;
  esac || return 1
  [ -s "$WORKDIR/identity.p12" ] || return 1
  # -T 预先授权 codesign 使用这把私钥，减少构建时弹出“允许访问钥匙串”。
  security import "$WORKDIR/identity.p12" -k "$KEYCHAIN" -P "$P12_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null 2>&1
}

IMPORTED=""
for mode in legacy pbe3des libressl; do
  if export_p12 "$mode"; then
    IMPORTED="$mode"
    break
  fi
  printf '  PKCS#12 格式 %s 不被 security import 接受，换下一种\n' "$mode"
done
[ -n "$IMPORTED" ] || fail "所有 PKCS#12 格式都无法导入钥匙串，请确认 /usr/bin/openssl 可用。"
printf '  已用 %s 格式导入成功\n' "$IMPORTED"

say "3/4 解除私钥访问限制（需要登录钥匙串密码）"
printf '登录钥匙串密码（输入不回显，仅用于本步 set-key-partition-list）：'
read -rs KEYCHAIN_PASSWORD
printf '\n'
if [ -n "$KEYCHAIN_PASSWORD" ]; then
  security set-key-partition-list \
    -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1 ||
    printf '警告：set-key-partition-list 失败，构建时可能弹出钥匙串授权对话框，点“始终允许”即可。\n'
  unset KEYCHAIN_PASSWORD
else
  printf '已跳过；构建时若弹出钥匙串授权对话框，点“始终允许”即可。\n'
fi

say "4/4 把证书设为受信任的代码签名身份（可选）"
mkdir -p "$CERT_EXPORT_DIR"
cp "$WORKDIR/cert.pem" "$CERT_EXPORT"
# codesign 签名本身不要求证书受信任：证书已在钥匙串搜索列表里即可使用。
# 受信任只影响 spctl/Gatekeeper 评估与 find-identity -v 的显示。
# 这一步会弹出系统认证对话框，因此加超时，避免在无人值守时卡死。
if [ "${SEMI_OS_SKIP_TRUST:-0}" = "1" ]; then
  printf '  已按 SEMI_OS_SKIP_TRUST=1 跳过信任设置\n'
elif semios_add_trust "$CERT_EXPORT"; then
  printf '  已写入用户域代码签名信任\n'
else
  printf '  未写入信任设置（不影响签名与 TCC 匹配）。如需，手动执行：\n'
  printf '    sudo security add-trusted-cert -d -r trustRoot -p codeSign \\\n'
  printf '      -k /Library/Keychains/System.keychain "%s"\n' "$CERT_EXPORT"
fi

say "验证"
# 不用 -v：-v 只列“证书链可信”的身份，而未写信任设置的证书仍然
# 能被 codesign 使用（指定要求里会是 certificate root/leaf 而非 cdhash）。
if ! security find-identity -p codesigning "$KEYCHAIN" | grep -Fq "\"$IDENTITY_NAME\""; then
  fail "创建后仍未在 find-identity 中找到 \"$IDENTITY_NAME\"，请检查钥匙串访问权限。"
fi
security find-identity -p codesigning "$KEYCHAIN" | grep -F "\"$IDENTITY_NAME\""
printf '\n（若上面标记 CSSMERR_TP_NOT_TRUSTED，仅表示证书尚未受信任，不影响签名。）\n'

cat <<NEXT

下一步：
  1. 把 apps/desktop/src-tauri/tauri.conf.json 的
     bundle.macOS.signingIdentity 设为 "$IDENTITY_NAME"
  2. 清掉 ad-hoc 时期留下的 TCC 记录（身份变了，旧记录不再匹配）：
       tccutil reset Accessibility dev.semios.desktop
       tccutil reset ScreenCapture dev.semios.desktop
       tccutil reset ListenEvent dev.semios.desktop
       tccutil reset Microphone dev.semios.desktop
  3. pnpm --filter @semi-os/desktop exec tauri build --debug
  4. 用 codesign -d -r- 确认指定要求里不再出现 cdhash（预期为
     certificate root/leaf = H"..."）：
       codesign -d -r- target/debug/bundle/macos/Semi-OS.app
NEXT
