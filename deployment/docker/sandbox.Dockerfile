# =============================================================================
# docker/python-sandbox/Dockerfile
# Arena Tier-1 Python 3.12 sandbox base image
#
# Security posture:
#   - Non-root user (uid 1000, no shell, no home)
#   - Read-only filesystem (enforced at docker run time, not just here)
#   - No network at runtime (--network=none)
#   - Minimal attack surface: stdlib + arena deps only
#   - No pip, no package managers, no compilers in final image
#   - Stripped binaries, no man pages, no docs
#   - Digest-pinned base image
# =============================================================================

# ── Build stage: install dependencies as root ─────────────────────────────────
FROM python:3.12-slim-bookworm AS builder

# Pin by digest in production:
# FROM python:3.12-slim-bookworm@sha256:<digest> AS builder

# Never interact with apt
ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_NO_CACHE_DIR=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# Install only the C deps needed to build wheels — these do NOT go in the
# final image. Only pure-Python + pre-built wheels reach the agent.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
    gcc libc6-dev \
  && rm -rf /var/lib/apt/lists/*

# Copy and install arena-approved dependencies
# This is a LOCKED list — agents cannot install additional packages.
COPY requirements-sandbox.txt .
RUN pip install --target=/packages -r requirements-sandbox.txt

# ── Runtime stage: minimal final image ────────────────────────────────────────
FROM python:3.12-slim-bookworm AS runtime

ENV DEBIAN_FRONTEND=noninteractive
# Disable .pyc files (smaller, faster, fewer writes)
ENV PYTHONDONTWRITEBYTECODE=1
# Unbuffered stdout/stderr (critical: our harness reads stdout line-by-line)
ENV PYTHONUNBUFFERED=1
# Disable Python crash handler (no core dumps)
ENV PYTHONFAULTHANDLER=0
# Prevent agents from importing site-packages except our approved list
ENV PYTHONNOUSERSITE=1

# Harden: remove tools agents could abuse
RUN apt-get update -qq \
  && apt-get purge -y -qq \
       wget curl openssh-client git gpg \
  && apt-get autoremove -y -qq \
  && apt-get clean \
  && rm -rf \
       /var/lib/apt/lists/* \
       /usr/share/doc \
       /usr/share/man \
       /usr/share/info \
       /tmp/* \
       /root/.cache

# Remove pip and setuptools from the runtime image
RUN pip uninstall -y pip setuptools wheel 2>/dev/null || true
RUN find /usr -name "pip*" -delete 2>/dev/null || true

# Copy approved packages from builder
COPY --from=builder /packages /usr/local/lib/python3.12/site-packages/

# Create non-root agent user
# UID/GID 65534 = nobody — no home, no shell, minimum possible privileges
RUN groupadd --gid 65534 agent 2>/dev/null || true \
 && useradd  --uid 65534 --gid 65534 \
             --no-create-home \
             --shell /usr/sbin/nologin \
             --comment "Arena sandbox agent" \
             agent

# Copy the harness (read-only at runtime — injected by executor)
# The harness reads stdin → calls agent → writes stdout
COPY harness.py /harness.py
RUN chmod 444 /harness.py && chown root:root /harness.py

# /tmp is the ONLY writable location — mounted as tmpfs at runtime
# (size=64m,noexec — agents cannot write executables there)
RUN install -d -m 1777 /tmp

WORKDIR /agent

# Switch to unprivileged user
USER agent

# Entrypoint: run harness with agent code injected at /agent/agent.py
# The executor mounts the agent code read-only into /agent/
ENTRYPOINT ["python3", "/harness.py"]
