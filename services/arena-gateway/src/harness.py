#!/usr/bin/env python3
"""
/harness.py — Arena Tier-1 Python sandbox harness
Baked into the base image. Never replaced by agent code.

Responsibilities:
  1. Read game_state JSON from stdin (one line)
  2. Import agent module from /agent/agent.py
  3. Call agent.strategy(game_state) with a wall-clock budget
  4. Write exactly one JSON line to stdout: the move
  5. On any failure: emit a fallback (first valid move or empty actions)

Security notes:
  - This file is root-owned 444; agents cannot modify it
  - sys.path manipulation is blocked (PYTHONPATH is unset at runtime)
  - agent.py runs in the same process but isolated by the OS-level sandbox
  - Any exception in agent code is caught; fallback is returned, not re-raised
  - Memory/CPU limits are enforced by Docker, not Python
"""

import json
import os
import sys
import signal
import traceback
import importlib.util
from pathlib import Path

# ── Constants ─────────────────────────────────────────────────────────────────

AGENT_FILE  = Path("/agent/agent.py")
TURN_BUDGET = int(os.environ.get("TURN_BUDGET_MS", "4500")) / 1000  # 4.5s default

# ── Timeout handling ──────────────────────────────────────────────────────────

class TurnTimeoutError(Exception):
    pass

def _timeout_handler(signum, frame):
    raise TurnTimeoutError("agent.strategy() exceeded turn budget")

# ── Fallback move builder ─────────────────────────────────────────────────────

def fallback_move(game_state: dict) -> dict:
    """Return the first valid move, or empty actions if none available."""
    valid = game_state.get("validMoves", [])
    actions = [valid[0]] if valid else []
    return {
        "actions":   actions,
        "nonce":     game_state.get("turnNonce", ""),
        "fallback":  True,
    }

# ── Agent loader ──────────────────────────────────────────────────────────────

def load_agent():
    """
    Load /agent/agent.py without executing it at module scope beyond
    normal import side-effects.  Returns the module object.
    Raises ImportError if the file is missing or has syntax errors.
    """
    if not AGENT_FILE.exists():
        raise ImportError(f"Agent file not found: {AGENT_FILE}")

    spec = importlib.util.spec_from_file_location("agent", AGENT_FILE)
    if spec is None or spec.loader is None:
        raise ImportError("Could not create module spec for agent.py")

    mod = importlib.util.module_from_spec(spec)

    # Restrict what the agent can import at module level by injecting a
    # sentinel into sys.modules — blocked modules raise ImportError when
    # the agent tries to import them.
    _block_dangerous_modules()

    spec.loader.exec_module(mod)
    return mod

_BLOCKED = frozenset({
    "subprocess", "multiprocessing", "socket", "socketserver",
    "http.server", "xmlrpc", "ftplib", "imaplib", "smtplib",
    "telnetlib", "poplib", "nntplib", "urllib.request",
    "urllib.robotparser", "asyncio",  # asyncio can spawn threads/subprocs
    "ctypes", "cffi", "mmap",
    "pty", "tty", "termios",
    "signal",    # agents cannot override our SIGALRM
    "gc",        # agents cannot disable garbage collection
    "sys",       # partial — imported but attribute access gated below
    "os",        # partial — restricted via __import__ override in agent ns
    "pickle", "shelve", "marshal",  # arbitrary code execution via deserialization
    "zipimport", "importlib.machinery",
    "_thread", "thread",
    "tkinter", "curses",
})

def _block_dangerous_modules():
    """Insert sentinel objects into sys.modules for blocked names."""
    class _Blocked:
        def __getattr__(self, name):
            raise ImportError(f"Module blocked by Arena sandbox: {self._name}")
        def __init__(self, name):
            self._name = name
        def __repr__(self):
            return f"<blocked module '{self._name}'>"

    for name in _BLOCKED:
        if name not in sys.modules:
            sys.modules[name] = _Blocked(name)

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # 1. Read game state from stdin
    try:
        raw = sys.stdin.readline()
        if not raw:
            raise ValueError("Empty stdin — no game state received")
        game_state = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        # Cannot proceed; emit a structured error to stderr and exit non-zero
        print(json.dumps({"error": f"stdin parse failed: {exc}", "actions": []}),
              file=sys.stdout, flush=True)
        sys.exit(1)

    # 2. Load agent module
    try:
        agent_mod = load_agent()
    except Exception as exc:
        print(json.dumps(fallback_move(game_state)), file=sys.stdout, flush=True)
        print(f"[harness] agent load error: {exc}", file=sys.stderr, flush=True)
        sys.exit(0)  # exit 0 so the executor uses the fallback, not the error

    # 3. Check agent has a strategy function
    strategy_fn = getattr(agent_mod, "strategy", None)
    if not callable(strategy_fn):
        print(json.dumps(fallback_move(game_state)), file=sys.stdout, flush=True)
        print("[harness] agent.py has no strategy() function", file=sys.stderr, flush=True)
        sys.exit(0)

    # 4. Call strategy() with a hard wall-clock limit
    signal.signal(signal.SIGALRM, _timeout_handler)
    signal.setitimer(signal.ITIMER_REAL, TURN_BUDGET)

    try:
        result = strategy_fn(game_state)
        signal.setitimer(signal.ITIMER_REAL, 0)  # cancel timer
    except TurnTimeoutError:
        print(json.dumps(fallback_move(game_state)), file=sys.stdout, flush=True)
        print("[harness] strategy() timed out", file=sys.stderr, flush=True)
        sys.exit(0)
    except Exception as exc:
        signal.setitimer(signal.ITIMER_REAL, 0)
        print(json.dumps(fallback_move(game_state)), file=sys.stdout, flush=True)
        print(f"[harness] strategy() raised: {exc}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(0)

    # 5. Validate and emit result
    try:
        # result must be a list of action dicts or a dict with 'actions' key
        if isinstance(result, list):
            actions = result
        elif isinstance(result, dict) and "actions" in result:
            actions = result["actions"]
        else:
            raise ValueError(f"strategy() returned unexpected type: {type(result)}")

        # Enforce that actions is a list
        assert isinstance(actions, list), "actions must be a list"
        # Enforce each action is a dict (basic shape check)
        for a in actions:
            assert isinstance(a, dict), f"each action must be a dict, got {type(a)}"

        output = {
            "actions": actions,
            "nonce":   game_state.get("turnNonce", ""),
        }
        # json.dumps will raise if result contains non-serialisable values
        print(json.dumps(output), file=sys.stdout, flush=True)
    except Exception as exc:
        print(json.dumps(fallback_move(game_state)), file=sys.stdout, flush=True)
        print(f"[harness] result validation failed: {exc}", file=sys.stderr, flush=True)
        sys.exit(0)


if __name__ == "__main__":
    main()
