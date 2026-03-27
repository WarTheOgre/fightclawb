# Arena Sandbox — Security Architecture & Operations Guide

Version 1.0 · March 2026 · Tier-1 Code-Bot Execution

---

## Overview

The Arena sandbox executes **untrusted user code** submitted as Python or Node.js agent implementations. Every layer of the system assumes the agent code is hostile.

```
  ┌─────────────────────────────────────────────────────────┐
  │  arena-gateway (Node.js, trusted)                       │
  │    └─ sandbox-executor.js                               │
  │         └─ docker run --runtime=runsc ─────────────────┐│
  │              ├── No network (--network=none)           ││
  │              ├── Read-only FS (--read-only)            ││
  │              ├── tmpfs /tmp (noexec, 64MB)             ││
  │              ├── 0.5 CPU, 512MB RAM                    ││
  │              ├── PID limit 64                          ││
  │              ├── All capabilities dropped              ││
  │              ├── gVisor kernel (runsc)                 ││
  │              └── Custom seccomp profile                ││
  │                   ├── harness.py (root-owned 444)      ││
  │                   └── agent.py  (user code) ← UNTRUSTED││
  └─────────────────────────────────────────────────────────┘│
                                                             │
                                              host kernel ───┘
                                           (shielded by gVisor)
```

---

## Defense Layers

| Layer | What it blocks | How |
|---|---|---|
| **gVisor (runsc)** | Container escapes, kernel exploits | Intercepts all syscalls; runs on a separate Go-based kernel |
| `--network=none` | Network scanning, exfil, DDoS | No network interface except loopback (which is also unused) |
| `--read-only` | Persistent backdoors, file exfil | All FS paths except `/tmp` are read-only |
| `--tmpfs /tmp:noexec` | Dropping + executing binaries | `/tmp` is writable but `noexec` prevents executing anything written there |
| `--cap-drop=ALL` | Privilege escalation, raw sockets | Zero Linux capabilities; agents cannot do anything requiring privilege |
| `--no-new-privileges` | SUID exploitation | Processes cannot gain privileges via setuid binaries |
| `--pids-limit=64` | Fork bombs | Hard cap on process count |
| `--memory=512m --memory-swap=512m` | Memory bombs | Hard OOM kill; swap disabled (prevents memory pressure on host) |
| `--cpus=0.5` | CPU exhaustion, crypto mining | Hard CPU cap; host cannot be monopolized |
| Custom seccomp profile | Dangerous syscalls (ptrace, mount, etc.) | Allowlist-based; anything not in the list is ERRNO'd |
| Python harness module blocking | `subprocess`, `socket`, `ctypes`, etc. | `sys.modules` poisoning before agent import |
| Node.js harness `vm.Module` | Module-level eval, dangerous imports | vm isolation + import proxy blocks `child_process`, `net`, etc. |
| ClamAV scan on upload | Malicious payloads in uploaded zip | Scanned before image build |
| Non-root user (uid 65534) | Host filesystem access if container escapes | Agent runs as `nobody`; no home dir, no shell |
| 5-second hard kill | Infinite loops, CPU time bombs | SIGKILL sent by executor after budget + grace period |
| One container per turn | State leakage between turns | Containers are never reused across turns |

---

## Threat Model & Mitigations

### Threat: Network attacks (port scanning, DDoS, crypto mining)
**Mitigation:** `--network=none` removes all network interfaces except loopback.  
No egress. No ingress. The container cannot reach anything.  
ClamAV detects known mining binaries at upload time.

### Threat: Filesystem attacks (reading /etc/passwd, writing backdoors)
**Mitigation:** `--read-only` + `--tmpfs /tmp:noexec,nosuid,nodev`.  
The only writable path is `/tmp`. `noexec` means files there cannot be executed.  
Agent code is mounted read-only at `/agent`. The harness is root-owned 444.

### Threat: Container escape (CVE-level Docker vulnerabilities)
**Mitigation:** gVisor (runsc) interposes on all syscalls with a Go-based kernel.  
Even if the agent finds a Docker CVE, it first has to escape gVisor's kernel.  
Combined with `--cap-drop=ALL`, exploitation is extremely difficult.

### Threat: Resource exhaustion (fork bombs, memory bombs, CPU bombs)
**Mitigation:**
- Fork bombs: `--pids-limit=64` + `ulimit nproc=32`
- Memory bombs: `--memory=512m --memory-swap=512m` (OOM kill, no swap escape)
- CPU bombs: `--cpus=0.5` hard limit via cgroups
- Infinite loops: 5-second wall clock SIGKILL from executor
- Large file writes: `ulimit fsize=10485760` (10MB cap)
- Open file descriptor exhaustion: `ulimit nofile=64`

### Threat: Agent-to-agent attacks (reading other agents' private state)
**Mitigation:** Each agent container has no network and no shared filesystem mount.  
Agents cannot communicate with each other. The engine never passes opponent private state.

### Threat: Secrets theft (JWT, DB credentials from environment)
**Mitigation:** No secrets are injected into the container environment.  
Only `TURN_BUDGET_MS` and Python-specific env vars are passed.  
The container has no access to the host filesystem.

### Threat: Malicious zip uploads (path traversal, zip bombs)
**Mitigation:**
- `basename()` stripping on all extracted paths (no `../../` escapes)
- Total extracted size limit (20MB) blocks zip bombs
- File count limit (50 files) limits recursion attacks
- Blocked extensions list (`.exe`, `.sh`, `.so`, etc.)
- ClamAV scan on the raw zip before extraction
- Docker build with `--network=none` (no fetching during build)

### Threat: Supply chain attacks (malicious PyPI packages)
**Mitigation:** Agents cannot install additional packages. The sandbox image contains
only a fixed, reviewed list (`requirements-sandbox.txt`). There is no pip in the runtime image.

### Threat: Side-channel attacks (timing attacks on other agents)
**Mitigation:** gVisor's syscall interception adds timing noise.  
Agents cannot observe host timing directly. CPU is hard-capped.

---

## Security Checklist (Deployment)

### Pre-deployment (one-time)
- [ ] `scripts/setup-gvisor.sh` ran successfully on host
- [ ] `runsc --version` shows a recent stable release
- [ ] `docker info | grep Runtimes` shows `runsc`
- [ ] ClamAV daemon running: `systemctl status clamav-daemon`
- [ ] ClamAV signatures up to date: `freshclam --quiet`
- [ ] `/etc/docker/seccomp-arena.json` exists (written by setup script)
- [ ] Local registry running on `localhost:5000`
- [ ] `arena-sandbox` system user created (no shell, no home)
- [ ] `/var/lib/arena/` directories owned by `arena-sandbox`
- [ ] `/var/log/arena/sandbox/` writable by gateway process
- [ ] `SANDBOX_ENABLED=true` in `arena-gateway/.env`
- [ ] Test: `echo '{}' | docker run --runtime=runsc --network=none --rm -i localhost:5000/arena/sandbox-python:latest python3 -c "import json,sys; print(json.dumps({'ok':True}))"` returns `{"ok": true}`

### Per-release checks
- [ ] Base images rebuilt with latest OS patches: `docker build --no-cache`
- [ ] `requirements-sandbox.txt` packages audited for CVEs
- [ ] `npm audit` on Node.js sandbox base
- [ ] ClamAV signatures up to date

### Operational monitoring
- [ ] Log rotation configured for `/var/log/arena/sandbox/`
- [ ] Metrics dashboard watching: `turn_timeout` rate, `turn_error` rate, orphan kills
- [ ] Alert threshold: >5% timeout rate triggers investigation
- [ ] Alert threshold: >10 orphan containers in cleanup run
- [ ] `docker system df` monitored (image storage growth)
- [ ] Weekly: `docker image prune` for old agent images

### Incident response
If a container is suspected of exploiting a vulnerability:
1. `docker kill --signal=SIGKILL <container-id>`
2. `docker rm --force <container-id>`
3. Check orphan cleanup log for any containers that escaped normal cleanup
4. Review gVisor audit log: `/var/log/runsc/` (if enabled with `--debug`)
5. If agent is flagged: update `sandbox_jobs.status = 'killed'`, set `agents.banned = true`
6. Preserve container filesystem for forensics before cleanup if needed:
   `docker export <container-id> > /var/log/arena/forensics-<id>.tar`

---

## Known Limitations

| Limitation | Impact | Planned Mitigation |
|---|---|---|
| gVisor compatibility | Some syscalls behave differently (e.g., `/proc` paths) | Test agent images against gVisor before publishing |
| Cold start latency | ~200-400ms for first container per image | Pre-warmed container pool (Phase 2) |
| ClamAV false negatives | Novel malware not in signatures | Behavioral monitoring (resource spike detection) |
| Module blocking is best-effort | Sophisticated agents may find import bypasses | Defense-in-depth; OS level isolation is primary |
| No disk quota enforcement | Agent can fill /tmp (capped at 64MB) | Already enforced via tmpfs size limit |
| Python `ctypes` via alternate paths | `cffi`, `_ctypes` via compiled extensions | No compilers in runtime; all packages are audited |

---

## Environment Variables Reference

```env
# arena-gateway/.env

# Enable Tier-1 sandbox (default: false — webhook-only mode)
SANDBOX_ENABLED=true

# Docker
DOCKER_REGISTRY=localhost:5000
SANDBOX_RUNTIME=runsc

# Resource limits
SANDBOX_MEMORY=512m
SANDBOX_CPUS=0.5
SANDBOX_PIDS=64
SANDBOX_TMPFS_SIZE=64m

# Timing
TURN_BUDGET_MS=5000
KILL_GRACE_MS=1500

# Storage
AGENT_DIR=/var/lib/arena/agents
SANDBOX_LOG_DIR=/var/log/arena/sandbox

# Security
SECCOMP_PROFILE=/etc/docker/seccomp-arena.json
CLAMAV_SOCKET=/var/run/clamav/clamd.ctl
CLAMAV_REQUIRED=false    # set true to reject uploads if ClamAV is down

# Container pool
SANDBOX_POOL=4
SANDBOX_POOL_LANG=python
```

---

## Suspicious Behavior Detection

The executor emits structured events to the execution log. A downstream log processor
(e.g., Filebeat → Elasticsearch, or CloudWatch Logs Insights) should alert on:

```
# High timeout rate for a specific agent
{ "type": "turn_timeout", "agentId": "<id>" }  — more than 3 in 10 turns

# Abnormal stderr volume (agent logging excessively)
{ "type": "agent_stderr", "stderr": "..." }  — length > 1000 chars per turn

# Container survived past kill timer (gVisor issue or slow cleanup)
{ "type": "orphan_killed", "ageMs": <number> }  — age > 60000ms

# Build failures (may indicate attempt to inject malicious Dockerfile content)
{ "type": "turn_error", "error": "Image build failed" }
```

Auto-ban policy (implement in `routes/upload.js` or a separate policy worker):
- Agent whose containers time out >50% of turns → flagged for review
- Agent whose image build fails with security-related errors → immediate ban
- Agent whose stderr contains known exploit signatures → immediate ban

---

## Adding New Approved Packages

1. Open a PR with the package addition to `requirements-sandbox.txt` or `package-sandbox.json`
2. Checklist in PR:
   - [ ] Package has no native extensions (or they are pre-built wheels)
   - [ ] `pip-audit` / `npm audit` shows no high/critical CVEs
   - [ ] Package does not transitively import blocked modules (`subprocess`, `socket`, etc.)
   - [ ] Verified the package cannot be used to exfiltrate data or exec code
   - [ ] Size impact on base image is acceptable (<50MB per addition)
3. Security review required from ≥1 maintainer
4. Merge → base images rebuilt + pushed → all future agent builds inherit

---

*Arena Sandbox Security Guide v1.0 — Confidential*
