#!/usr/bin/env bash
set -euo pipefail

image="${PI_SANDBOX_IMAGE:-pi-harness:0.83.0}"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}"
mkdir -p "$cache_root"
fixture="$(mktemp -d "$cache_root/pi-containment.XXXXXX")"
host_escape_target="${fixture}.escape"
trap 'rm -rf "$fixture"; rm -f "$host_escape_target"' EXIT

docker image inspect "$image" >/dev/null

docker run --rm \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --network=none \
  --env "HOST_ESCAPE_TARGET=$host_escape_target" \
  --mount "type=bind,src=$fixture,dst=/workspace" \
  --entrypoint /bin/bash \
  "$image" -lc '
set -u
passed=0
failed=0

check() {
  name="$1"
  shift
  if "$@"; then
    printf "PASS %s\n" "$name"
    passed=$((passed + 1))
  else
    printf "FAIL %s\n" "$name"
    failed=$((failed + 1))
  fi
}

expect_fail() {
  name="$1"
  shift
  if "$@" >/tmp/check.out 2>/tmp/check.err; then
    printf "FAIL %s\n" "$name"
    failed=$((failed + 1))
  else
    printf "PASS %s\n" "$name"
    passed=$((passed + 1))
  fi
}

check workspace-write /usr/bin/touch /workspace/allowed
expect_fail rootfs-write /usr/bin/touch /opt/escape
expect_fail shell-redirection /bin/sh -c "printf x >/etc/escape"
/bin/ln -s /etc /workspace/etc-link
expect_fail symlink-escape /usr/bin/touch /workspace/etc-link/escape
expect_fail subprocess-escape /bin/bash -c "/usr/bin/touch /usr/local/escape"
escape_alias() { /usr/bin/touch /var/escape; }
expect_fail alias-escape escape_alias
expect_fail host-path-write /usr/bin/touch "$HOST_ESCAPE_TARGET"
check host-home-absent /usr/bin/test ! -e /Users/kanna
check ssh-credential-absent /usr/bin/test ! -e /home/pi/.ssh/id_rsa
check cloud-credential-absent /usr/bin/test ! -e /home/pi/.config/gcloud/credentials.db
check docker-socket-absent /usr/bin/test ! -S /var/run/docker.sock
expect_fail network-direct /usr/local/bin/node -e "const n=require(\"net\");const s=n.connect(443,\"1.1.1.1\");s.on(\"connect\",()=>process.exit(0));s.on(\"error\",()=>process.exit(2));setTimeout(()=>process.exit(3),2000)"
expect_fail network-dns /usr/local/bin/node -e "require(\"dns\").lookup(\"example.com\",e=>process.exit(e?2:0));setTimeout(()=>process.exit(3),2000)"
expect_fail tmp-noexec /bin/sh -c "printf \"#!/bin/sh\\nexit 0\\n\" >/tmp/run-me && chmod +x /tmp/run-me && /tmp/run-me"
check unprivileged-user /usr/bin/test "$(id -u)" = 10001
check capabilities-dropped /bin/grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status
check no-new-privileges /bin/grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status

printf "RESULT pass=%d fail=%d\n" "$passed" "$failed"
test "$failed" -eq 0
'

test -e "$fixture/allowed"
test ! -e "$host_escape_target"
