#!/usr/bin/env bash
# =============================================================================
# setup-gvisor.sh — Install gVisor (runsc) on Ubuntu 24.04 + harden Docker
# =============================================================================
# Run as root or with sudo.
# Safe to re-run; all steps are idempotent.
#
# What this script does:
#   1. Installs gVisor runsc runtime
#   2. Registers runsc with Docker daemon
#   3. Configures Docker daemon security defaults
#   4. Installs ClamAV for agent upload scanning
#   5. Creates the arena-sandbox system user (no login, no home)
#   6. Creates log + image-store directories with correct permissions
#   7. Verifies the install with a hello-world sanity check
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

require_root() {
  [[ $EUID -eq 0 ]] || error "Run as root: sudo $0"
}

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
require_root
info "Updating apt cache..."
apt-get update -qq

info "Installing prerequisites..."
apt-get install -y -qq \
  curl gnupg ca-certificates lsb-release \
  apt-transport-https software-properties-common \
  clamav clamav-daemon \
  jq

# ── 2. Install gVisor ─────────────────────────────────────────────────────────
info "Adding gVisor apt repository..."
KEYRING=/usr/share/keyrings/gvisor-archive-keyring.gpg

curl -fsSL https://gvisor.dev/archive.key \
  | gpg --dearmor -o "$KEYRING"

echo "deb [arch=$(dpkg --print-architecture) signed-by=${KEYRING}] \
  https://storage.googleapis.com/gvisor/releases release main" \
  > /etc/apt/sources.list.d/gvisor.list

apt-get update -qq
apt-get install -y -qq runsc

info "gVisor version: $(runsc --version)"

# ── 3. Register runsc with Docker ─────────────────────────────────────────────
info "Registering runsc runtime with Docker..."
runsc install   # writes /etc/docker/daemon.json runtimes entry

# ── 4. Harden Docker daemon config ────────────────────────────────────────────
info "Writing hardened Docker daemon config..."

DAEMON_CFG=/etc/docker/daemon.json

# Merge our settings with whatever runsc install already wrote
python3 - <<'PY'
import json, sys

cfg_path = '/etc/docker/daemon.json'
try:
    with open(cfg_path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    cfg = {}

# Ensure runsc runtime entry exists (runsc install writes this, but be safe)
cfg.setdefault('runtimes', {})
cfg['runtimes'].setdefault('runsc', {'path': 'runsc'})

# Security hardening
cfg.update({
    # Disable userland proxy — fewer attack surfaces
    'userland-proxy': False,
    # No inter-container communication by default
    'icc': False,
    # Log driver: json-file with size cap
    'log-driver': 'json-file',
    'log-opts': {
        'max-size': '10m',
        'max-file': '3'
    },
    # Content trust
    'disable-legacy-registry': True,
    # Prevent containers setting more capabilities than the daemon
    'no-new-privileges': True,
})

with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)
print('daemon.json written OK')
PY

info "Reloading Docker daemon..."
systemctl reload docker || systemctl restart docker

# ── 5. ClamAV setup ───────────────────────────────────────────────────────────
info "Configuring ClamAV (freshclam update)..."
# freshclam may fail on first run if DB is missing; ignore exit code
systemctl stop clamav-freshclam 2>/dev/null || true
freshclam --quiet || warn "freshclam update failed (network issue?); update DB manually later"
systemctl enable --now clamav-freshclam 2>/dev/null || true
systemctl enable --now clamav-daemon 2>/dev/null || true

# ── 6. Create service account and directories ──────────────────────────────────
info "Creating arena-sandbox system user..."
if ! id arena-sandbox &>/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin arena-sandbox
fi

# Add to docker group so it can spawn containers
usermod -aG docker arena-sandbox

info "Creating directory layout..."
install -d -m 750 -o arena-sandbox -g arena-sandbox \
  /var/lib/arena/agents \
  /var/lib/arena/uploads \
  /var/log/arena/sandbox

# Local registry storage (if using a self-hosted registry)
install -d -m 755 /var/lib/arena/registry

# ── 7. Local Docker registry (optional but recommended) ───────────────────────
info "Starting local Docker registry on port 5000..."
docker pull registry:2 --quiet
docker run -d \
  --name arena-registry \
  --restart unless-stopped \
  -p 127.0.0.1:5000:5000 \
  -v /var/lib/arena/registry:/var/lib/registry \
  registry:2 \
  || warn "Registry container may already be running"

# Mark registry as insecure (localhost only — never do this for external)
python3 - <<'PY'
import json
cfg_path = '/etc/docker/daemon.json'
with open(cfg_path) as f:
    cfg = json.load(f)
cfg.setdefault('insecure-registries', [])
if 'localhost:5000' not in cfg['insecure-registries']:
    cfg['insecure-registries'].append('localhost:5000')
with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)
PY
systemctl reload docker

# ── 8. Build sandbox base images ──────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

info "Building Python sandbox base image..."
docker build \
  -t localhost:5000/arena/sandbox-python:latest \
  -f "${REPO_ROOT}/docker/python-sandbox/Dockerfile" \
  "${REPO_ROOT}/docker/python-sandbox"

docker push localhost:5000/arena/sandbox-python:latest

info "Building Node.js sandbox base image..."
docker build \
  -t localhost:5000/arena/sandbox-node:latest \
  -f "${REPO_ROOT}/docker/node-sandbox/Dockerfile" \
  "${REPO_ROOT}/docker/node-sandbox"

docker push localhost:5000/arena/sandbox-node:latest

# ── 9. Sanity check ───────────────────────────────────────────────────────────
info "Running gVisor sanity check..."
RESULT=$(echo '{"test":true}' | docker run \
  --runtime=runsc \
  --rm -i \
  --network=none \
  --read-only \
  --tmpfs /tmp:size=16m,noexec \
  --memory=64m \
  --cpus=0.1 \
  --cap-drop=ALL \
  --no-new-privileges \
  --security-opt="no-new-privileges:true" \
  --security-opt="seccomp=/etc/docker/seccomp-arena.json" \
  localhost:5000/arena/sandbox-python:latest \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({'ok':True,'echo':d}))" \
  2>/dev/null || echo '{"ok":false}')

if echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('ok')" 2>/dev/null; then
  info "✓ gVisor sandbox is working correctly"
else
  warn "Sanity check returned: $RESULT"
  warn "Check that runsc is installed and Docker was reloaded"
fi

# ── 10. seccomp profile ───────────────────────────────────────────────────────
info "Writing Arena seccomp profile..."
cat > /etc/docker/seccomp-arena.json <<'SECCOMP'
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "syscalls": [
    {
      "names": [
        "read", "write", "open", "openat", "close", "stat", "fstat", "lstat",
        "poll", "lseek", "mmap", "mprotect", "munmap", "brk", "rt_sigaction",
        "rt_sigprocmask", "rt_sigreturn", "ioctl", "pread64", "pwrite64",
        "readv", "writev", "access", "pipe", "select", "sched_yield",
        "mremap", "msync", "mincore", "madvise", "dup", "dup2",
        "nanosleep", "getitimer", "alarm", "setitimer", "getpid",
        "sendfile", "socket", "connect", "accept", "sendto", "recvfrom",
        "shutdown", "bind", "listen", "getsockname", "getpeername",
        "socketpair", "setsockopt", "getsockopt", "clone", "fork", "vfork",
        "execve", "exit", "wait4", "kill", "uname", "semget", "semop",
        "semctl", "shmdt", "msgget", "msgsnd", "msgrcv", "msgctl",
        "fcntl", "flock", "fsync", "fdatasync", "truncate", "ftruncate",
        "getdents", "getcwd", "chdir", "rename", "mkdir", "rmdir",
        "unlink", "symlink", "readlink", "chmod", "fchmod", "chown",
        "fchown", "lchown", "umask", "gettimeofday", "getrlimit",
        "getrusage", "sysinfo", "times", "getuid", "getgid", "getegid",
        "geteuid", "setgid", "setuid", "getgroups", "getppid",
        "getpgrp", "setsid", "getpgid", "setpgid",
        "rt_sigsuspend", "sigaltstack", "utime", "mknod", "uselib",
        "ustat", "statfs", "fstatfs", "getpriority", "setpriority",
        "prctl", "arch_prctl", "adjtimex", "setrlimit", "chroot",
        "sync", "acct", "settimeofday", "swapon", "swapoff", "reboot",
        "sethostname", "setdomainname", "iopl", "ioperm", "gettid",
        "readahead", "setxattr", "lsetxattr", "fsetxattr", "getxattr",
        "lgetxattr", "fgetxattr", "listxattr", "llistxattr", "flistxattr",
        "removexattr", "lremovexattr", "fremovexattr", "tkill", "futex",
        "sched_setaffinity", "sched_getaffinity", "set_thread_area",
        "io_setup", "io_destroy", "io_getevents", "io_submit", "io_cancel",
        "get_thread_area", "lookup_dcookie", "epoll_create", "epoll_ctl_old",
        "epoll_wait_old", "remap_file_pages", "getdents64", "set_tid_address",
        "restart_syscall", "semtimedop", "fadvise64", "timer_create",
        "timer_settime", "timer_gettime", "timer_getoverrun", "timer_delete",
        "clock_settime", "clock_gettime", "clock_getres", "clock_nanosleep",
        "exit_group", "epoll_wait", "epoll_ctl", "tgkill", "utimes",
        "mbind", "set_mempolicy", "get_mempolicy", "mq_open", "mq_unlink",
        "mq_timedsend", "mq_timedreceive", "mq_notify", "mq_getsetattr",
        "waitid", "add_key", "request_key", "keyctl", "ioprio_set",
        "ioprio_get", "inotify_init", "inotify_add_watch", "inotify_rm_watch",
        "openat", "mkdirat", "mknodat", "fchownat", "futimesat", "newfstatat",
        "unlinkat", "renameat", "linkat", "symlinkat", "readlinkat", "fchmodat",
        "faccessat", "pselect6", "ppoll", "unshare", "set_robust_list",
        "get_robust_list", "splice", "tee", "sync_file_range", "vmsplice",
        "move_pages", "utimensat", "epoll_pwait", "signalfd", "timerfd_create",
        "eventfd", "fallocate", "timerfd_settime", "timerfd_gettimerfd",
        "signalfd4", "eventfd2", "epoll_create1", "dup3", "pipe2",
        "inotify_init1", "preadv", "pwritev", "recvmmsg", "fanotify_init",
        "fanotify_mark", "prlimit64", "name_to_handle_at", "open_by_handle_at",
        "clock_adjtime", "syncfs", "sendmmsg", "setns", "getcpu",
        "process_vm_readv", "process_vm_writev", "kcmp", "finit_module",
        "sched_setattr", "sched_getattr", "renameat2", "seccomp",
        "getrandom", "memfd_create", "kexec_file_load", "bpf",
        "execveat", "userfaultfd", "membarrier", "mlock2", "copy_file_range",
        "preadv2", "pwritev2", "pkey_mprotect", "pkey_alloc", "pkey_free",
        "statx", "io_pgetevents", "rseq"
      ],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["ptrace", "perf_event_open", "kexec_load", "syslog",
                "acct", "pivot_root", "mount", "umount2", "swapon", "swapoff",
                "nfsservctl", "quotactl", "init_module", "delete_module",
                "create_module", "get_kernel_syms", "query_module"],
      "action": "SCMP_ACT_ERRNO"
    }
  ]
}
SECCOMP

info "Setup complete!"
echo ""
echo "  Summary:"
echo "    gVisor runtime:     $(runsc --version | head -1)"
echo "    Python base image:  localhost:5000/arena/sandbox-python:latest"
echo "    Node base image:    localhost:5000/arena/sandbox-node:latest"
echo "    Local registry:     localhost:5000"
echo "    Log directory:      /var/log/arena/sandbox"
echo "    Agent storage:      /var/lib/arena/agents"
echo ""
echo "  Next steps:"
echo "    1. Set DOCKER_REGISTRY=localhost:5000 in arena-gateway/.env"
echo "    2. Set SANDBOX_ENABLED=true in arena-gateway/.env"
echo "    3. Restart arena-gateway"
