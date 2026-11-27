#!/usr/bin/env bash
# Make QNB workspace VMs (Docker containers) report their own limits in /proc:
# `free`, `top`, `uptime`, /proc/cpuinfo then show 2 GiB / 2 CPUs instead of the host's totals
# (`nproc` reads the CPU affinity mask and keeps showing the host count).
#
#   sudo bash deploy/host/install-lxcfs.sh
#
# 1. builds and installs LXCFS (Amazon Linux 2023 has no package) and runs it as lxcfs.service
# 2. patches the QNB runtime manager to bind-mount LXCFS's /proc files into every VM container
# 3. restarts the manager and recreates VM containers (workspace files are kept on the host)
# Re-running is safe: every step checks whether it is already done.
set -euo pipefail

LXCFS_VERSION=6.0.6   # LTS series
LXCFS_SHA256=386339ba4cde289b0f6df4fe7a614caa1e45dd91bc0200b4aff6c51bf9d5ef9e
MANAGER=/usr/local/lib/qnb-container-runtime/manager.py
SERVICE=qnb-runtime-manager.service
GUEST_IMAGE=qnb-runtime-guest:local

[[ $EUID -eq 0 ]] || { echo "sudo로 실행하세요: sudo bash $0" >&2; exit 1; }
[[ -f $MANAGER ]] || { echo "런타임 관리자를 찾을 수 없습니다: $MANAGER" >&2; exit 1; }

echo "==> 1/4 LXCFS ${LXCFS_VERSION} 설치"
if ! /usr/bin/lxcfs --version 2>&1 | tr -d '"' | grep -qx "$LXCFS_VERSION"; then
  dnf install -y -q gcc meson ninja-build fuse3 fuse3-devel systemd systemd-devel pkgconf-pkg-config python3-jinja2
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fsSL -o "$work/lxcfs.tar.gz" "https://github.com/lxc/lxcfs/releases/download/v${LXCFS_VERSION}/lxcfs-${LXCFS_VERSION}.tar.gz"
  echo "${LXCFS_SHA256}  $work/lxcfs.tar.gz" | sha256sum -c --quiet -
  tar -xzf "$work/lxcfs.tar.gz" -C "$work"
  (
    cd "$work/lxcfs-${LXCFS_VERSION}"
    meson setup build --prefix=/usr --sysconfdir=/etc --localstatedir=/var -Ddocs=false -Dinit-script=systemd >/dev/null
    ninja -C build >/dev/null
    ninja -C build install >/dev/null
  )
fi
# --enable-cfs: report the container's CPU quota (docker --cpus) in /proc/cpuinfo and /proc/stat.
# -l: per-container /proc/loadavg.
mkdir -p /etc/systemd/system/lxcfs.service.d
cat > /etc/systemd/system/lxcfs.service.d/qnb.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/bin/lxcfs --enable-cfs -l /var/lib/lxcfs
UNIT
systemctl daemon-reload
systemctl enable lxcfs.service
systemctl restart lxcfs.service
for _ in $(seq 1 20); do mountpoint -q /var/lib/lxcfs && break; sleep 0.5; done
mountpoint -q /var/lib/lxcfs || { echo "LXCFS가 /var/lib/lxcfs에 마운트되지 않았습니다: journalctl -u lxcfs" >&2; exit 1; }
echo "    lxcfs $(/usr/bin/lxcfs --version 2>&1 | tr -d '"') 실행 중 (/var/lib/lxcfs)"

echo "==> 2/4 런타임 관리자에 LXCFS 마운트 추가"
if grep -q "def lxcfs_args" "$MANAGER"; then
  echo "    이미 적용되어 있습니다."
else
  cp -p "$MANAGER" "$MANAGER.bak-$(date +%Y%m%d%H%M%S)"
  python3 - "$MANAGER" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
helper = '''

LXCFS_ROOT = Path("/var/lib/lxcfs")
LXCFS_FILES = ("proc/cpuinfo", "proc/diskstats", "proc/loadavg", "proc/meminfo", "proc/stat",
               "proc/swaps", "proc/uptime", "proc/slabinfo", "sys/devices/system/cpu/online")


def lxcfs_args():
    """Bind LXCFS views over /proc so free, top and /proc/cpuinfo report this container's cgroup limits."""
    if not os.path.ismount(LXCFS_ROOT):
        return []
    args = []
    for rel in LXCFS_FILES:
        source = LXCFS_ROOT / rel
        if source.exists():
            args += ["-v", f"{source}:/{rel}:ro"]
    return args
'''
anchor = re.search(r'^MAX_ACTIVE = .*$', src, re.M)
if not anchor:
    sys.exit("MAX_ACTIVE 상수를 찾지 못해 자동 수정을 중단합니다.")
src = src[:anchor.end()] + helper + src[anchor.end():]
run_args = re.search(r'^(\s*)"--tmpfs", .*\n', src, re.M)
if not run_args:
    sys.exit("docker run 인자(--tmpfs)를 찾지 못해 자동 수정을 중단합니다.")
src = src[:run_args.end()] + f'{run_args.group(1)}*lxcfs_args(),\n' + src[run_args.end():]
if not re.search(r'^import os\b|^import .*\bos\b', src, re.M):
    src = "import os\n" + src
if not re.search(r'^from pathlib import .*\bPath\b', src, re.M):
    src = "from pathlib import Path\n" + src
open(path, "w", encoding="utf-8").write(src)
PY
  python3 -m py_compile "$MANAGER"
fi

echo "==> 3/4 관리자 재시작 및 VM 컨테이너 재생성"
if ! systemctl restart "$SERVICE"; then
  latest=$(ls -t "$MANAGER".bak-* 2>/dev/null | head -1 || true)
  [[ -n $latest ]] && cp -p "$latest" "$MANAGER" && systemctl restart "$SERVICE"
  echo "관리자 재시작에 실패해 이전 버전으로 되돌렸습니다: journalctl -u $SERVICE" >&2
  exit 1
fi
# Running VMs keep the old mounts until recreated. Files live under /var/lib/agora-runtime and are kept;
# open terminals and Python kernels in those VMs are interrupted and reconnect on next use.
mapfile -t vms < <(docker ps -aq --filter "name=^/qnb-vm-")
if ((${#vms[@]})); then
  docker rm -f "${vms[@]}" >/dev/null
  echo "    VM 컨테이너 ${#vms[@]}개 정리 (다음 접속 때 새 설정으로 다시 생성)"
fi

echo "==> 4/4 확인"
args=$(python3 -c "import runpy; print(' '.join(runpy.run_path('$MANAGER')['lxcfs_args']()))")
docker run --rm --memory 2g --memory-swap 2g --cpus 2 $args "$GUEST_IMAGE" \
  sh -c 'echo "    free: $(free -m | awk "/^Mem:/ {print \$2}") MiB · /proc/cpuinfo CPU: $(grep -c ^processor /proc/cpuinfo)개 · $(head -1 /proc/meminfo)"'
echo "완료: 새로 만들어지는 VM은 free/top/cpuinfo에 메모리 2 GiB · CPU 2개로 표시됩니다."
echo "참고: nproc은 CPU affinity를 읽기 때문에 계속 호스트 CPU 수를 표시합니다."
