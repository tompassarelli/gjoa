#!/usr/bin/env python3
"""Post-edit hook worker: type-check enrichment + repair agent pool.

After each file edit, queries the beagle daemon for type errors. If errors
exist, dispatches to an agent pool (autoscaling 1-3). Relays agent status
updates (done, needs-context, failed) back to the primary agent.

Pool architecture:
  .beagle/pool.json         — config: min/max agents, model, budget
  .beagle/pool-log.jsonl    — event log (spawn, done, failed, queued, context-request)
  .beagle/agents/{id}/      — per-agent working directory
    task.json               — assigned task (file, errors, step hash)
    status                  — working | needs-context | done | failed | archived
    system-prompt.txt       — agent's system prompt (with AGENT_DIR resolved)
    user-prompt.txt         — task prompt
    result.md               — agent's output
    request.md              — context request (if needs-context)
    response.md             — primary agent's response (if context requested)
    run.sh                  — wrapper script
  .beagle/queue/            — overflow tasks when pool is full
    {timestamp}-{hash}.json — queued task
"""

import json
import os
import sys
import subprocess
import hashlib
import time
import glob
import shutil


def find_tool(name):
    """Find a beagle tool binary. Checks sibling bin/, $BEAGLE_PATH/bin, then $PATH."""
    hook_dir = os.path.dirname(os.path.abspath(__file__))
    project_bin = os.path.join(hook_dir, "..", "..", "bin", name)
    if os.path.isfile(project_bin):
        return os.path.abspath(project_bin)
    bp = os.environ.get("BEAGLE_PATH")
    if bp:
        candidate = os.path.join(bp, "bin", name)
        if os.path.isfile(candidate):
            return candidate
    return shutil.which(name)


# The project being edited — its .beagle/ working area (agents, queue, config,
# logs) lives HERE, not in the beagle checkout. Mirrors simple mode, so pool
# mode is portable to any project rather than hardcoded to one machine.
PROJECT_DIR = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())
# Beagle tools resolve dynamically (sibling bin/, $BEAGLE_PATH/bin, then $PATH).
DAEMON_BIN = find_tool("beagle-daemon")
SYNTAX_BIN = find_tool("beagle-syntax")
AGENTS_DIR = f"{PROJECT_DIR}/.beagle/agents"
QUEUE_DIR = f"{PROJECT_DIR}/.beagle/queue"
POOL_LOG = f"{PROJECT_DIR}/.beagle/pool-log.jsonl"
PROMPT_FILE = f"{PROJECT_DIR}/.beagle/repair-agent-prompt.md"
POOL_CONFIG_FILE = f"{PROJECT_DIR}/.beagle/pool.json"
PORT_FILE = os.environ.get("BEAGLE_DAEMON_PORTFILE", "/var/tmp/beagle-daemon.port")

BEAGLE_EXTENSIONS = frozenset({
    ".bgl", ".bclj", ".bcljs", ".bjs", ".bnix", ".bsql", ".bpy", ".rkt",
})

DEFAULT_POOL_CONFIG = {
    "min_agents": 1,
    "max_agents": 3,
    "model": "opus",
    "budget_per_task_usd": 0.50,
}


def log_event(event, **kwargs):
    """Append a structured event to the pool log."""
    entry = {"ts": time.time(), "event": event, **kwargs}
    try:
        with open(POOL_LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def load_pool_config():
    try:
        with open(POOL_CONFIG_FILE) as f:
            cfg = json.load(f)
        return {**DEFAULT_POOL_CONFIG, **cfg}
    except Exception:
        return DEFAULT_POOL_CONFIG


def get_file_path(tool_input_json):
    try:
        d = json.loads(tool_input_json)
        return d.get("tool_input", {}).get("file_path", "")
    except Exception:
        return ""


def ensure_daemon_running():
    """Start daemon if not running. Returns True if daemon is reachable."""
    import socket
    try:
        if os.path.exists(PORT_FILE):
            port = int(open(PORT_FILE).read().strip())
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(1)
            sock.connect(("127.0.0.1", port))
            sock.send(b"ping\n")
            sock.recv(64)
            sock.close()
            return True
    except Exception:
        pass
    try:
        subprocess.Popen(
            [DAEMON_BIN, "start"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.0)
        return True
    except Exception:
        return False


def _syntax_json(file_path):
    result = subprocess.run(
        [SYNTAX_BIN, "--json", file_path],
        capture_output=True, text=True, timeout=5
    )
    if result.returncode == 0:
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return None if data.get("status") == "ok" else data


def run_syntax_check(file_path):
    """Pass 0: structural check with deterministic auto-balance.
    Returns (message, has_errors)."""
    try:
        data = _syntax_json(file_path)
        if data is None:
            return None, False

        # Deterministic auto-balance (parinfer indent-mode). --repair --write
        # applies ONLY when high-confidence + re-verified balanced, so it never
        # writes a guess. The model must never hand-count parens.
        subprocess.run(
            [SYNTAX_BIN, "--repair", "--write", file_path],
            capture_output=True, text=True, timeout=5
        )
        after = _syntax_json(file_path)
        filename = os.path.basename(file_path)

        if after is None:
            return (f"beagle-syntax: {filename} — auto-balanced delimiters "
                    f"(deterministic, re-verified). File updated on disk — "
                    f"re-read before further edits.", False)

        lines = [f"beagle-syntax: {filename} — STRUCTURAL ERROR (not auto-fixable; ambiguous)"]
        for e in after.get("errors", []):
            lines.append(f"  {e.get('line', 0)}:{e.get('col', 0)} {e.get('detail', '')}")
        for name, key in [("()", "parens"), ("[]", "brackets"), ("{}", "braces")]:
            c = after.get("counts", {}).get(key, {})
            bal = c.get("balance", 0)
            if bal != 0:
                lines.append(
                    f"  {name} open:{c.get('open',0)} close:{c.get('close',0)} "
                    f"balance:{bal:+d} UNBALANCED"
                )
        lines.append(f"  review: bin/beagle-syntax --repair --emit-patch {file_path}")
        return "\n".join(lines), True
    except (subprocess.TimeoutExpired, Exception):
        return None, False


def ensure_daemon_watches(file_path):
    """Tell the daemon to watch the file's directory if it isn't already."""
    file_dir = os.path.dirname(file_path)
    try:
        subprocess.run(
            [DAEMON_BIN, "query", "watch", file_dir],
            capture_output=True, text=True, timeout=3
        )
    except Exception:
        pass


def query_daemon(file_path):
    """Query daemon for cached check result; fall back to synchronous check."""
    try:
        result = subprocess.run(
            [DAEMON_BIN, "query", "check-result", file_path],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            parsed = json.loads(result.stdout)
            if parsed and parsed.get("result") and parsed["result"] != "null":
                return parsed
    except Exception:
        pass

    try:
        result = subprocess.run(
            [DAEMON_BIN, "query", "check-enriched", file_path],
            capture_output=True, text=True, timeout=8
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception:
        pass

    return None


def format_errors(check_result, file_path):
    r = check_result.get("result")
    if not r or r == "null":
        return None, 0, 0

    errors = r.get("error_count", 0)
    if errors == 0:
        return None, 0, 0

    auto = r.get("auto_fixable", 0)
    h = r.get("content_hash", "?")[:8]
    filename = os.path.basename(file_path)

    lines = [f"beagle-check: {filename} ({errors} errors, {auto} auto-fixable) [hash:{h}]"]

    for e in r.get("errors", []):
        line_num = e.get("line", 0)
        kind = e.get("kind", "?")
        msg = e.get("message", "")
        short = msg.split(": ")[-1] if ": " in msg else msg
        lines.append(f"  L{line_num} [{kind}]: {short}")

        fp = e.get("fix_plan")
        if fp and isinstance(fp, dict):
            hint = fp.get("fix-hint", "")
            if hint:
                lines.append(f"    -> {hint}")

        ctx = e.get("context")
        if ctx and isinstance(ctx, dict):
            for rec_key, fields in ctx.items():
                if isinstance(fields, list):
                    names = [f"{f['accessor']} : {f['type']}" for f in fields[:4]]
                    lines.append(f"    {rec_key}: {', '.join(names)}")

    for s in r.get("suspicions", []):
        conf = s.get("confidence", 0)
        msg = s.get("message", "")
        lines.append(f"  SUSPECT [{conf}]: {msg}")

    if auto > 0:
        lines.append(f"  run `beagle-fix --apply .` to auto-fix {auto} errors")

    return "\n".join(lines), errors, auto


def make_step_hash(file_path):
    raw = f"{file_path}:{int(time.time())}"
    return hashlib.sha256(raw.encode()).hexdigest()[:8]


# --- Pool management ---

def get_active_agents():
    """Return list of (agent_id, status, file_path) for non-archived agents."""
    agents = []
    for status_file in glob.glob(f"{AGENTS_DIR}/*/status"):
        agent_dir = os.path.dirname(status_file)
        agent_id = os.path.basename(agent_dir)

        with open(status_file) as f:
            status = f.read().strip()

        if status == "archived":
            continue

        task_file = os.path.join(agent_dir, "task.json")
        file_path = None
        step_hash = None
        if os.path.exists(task_file):
            with open(task_file) as f:
                task = json.load(f)
            file_path = task.get("file")
            step_hash = task.get("step_hash")

        agents.append({
            "id": agent_id,
            "dir": agent_dir,
            "status": status,
            "file": file_path,
            "step_hash": step_hash,
        })
    return agents


def count_working_agents(agents):
    return sum(1 for a in agents if a["status"] in ("working", "needs-context"))


def agent_for_file(agents, file_path):
    for a in agents:
        if a["file"] == file_path and a["status"] in ("working", "needs-context"):
            return a["id"]
    return None


def spawn_agent(file_path, error_text, step_hash, config):
    """Spawn a repair agent for the given file."""
    if not os.path.exists(PROMPT_FILE):
        return None

    agent_id = f"agent-{step_hash}"
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    os.makedirs(agent_dir, exist_ok=True)

    task = {
        "file": file_path,
        "step_hash": step_hash,
        "spawned_at": time.time(),
        "errors": error_text,
    }
    with open(os.path.join(agent_dir, "task.json"), "w") as f:
        json.dump(task, f)

    with open(os.path.join(agent_dir, "status"), "w") as f:
        f.write("working")

    with open(PROMPT_FILE) as f:
        system_prompt = f.read()
    system_prompt = system_prompt.replace("AGENT_DIR", agent_dir)

    user_prompt = (
        f"Fix the type errors in {file_path}.\n\n"
        f"Error diagnostics:\n{error_text}\n\n"
        f"Agent ID: {agent_id}\n"
        f"Agent directory: {agent_dir}\n"
        f"Step hash: {step_hash}\n\n"
        f"Read the file, fix each error, and report what you changed."
    )

    sys_prompt_file = os.path.join(agent_dir, "system-prompt.txt")
    user_prompt_file = os.path.join(agent_dir, "user-prompt.txt")
    result_file = os.path.join(agent_dir, "result.md")
    status_file = os.path.join(agent_dir, "status")

    with open(sys_prompt_file, "w") as f:
        f.write(system_prompt)
    with open(user_prompt_file, "w") as f:
        f.write(user_prompt)

    model = config.get("model", "opus")
    budget = str(config.get("budget_per_task_usd", 0.50))

    wrapper_script = os.path.join(agent_dir, "run.sh")
    with open(wrapper_script, "w") as f:
        f.write("#!/usr/bin/env bash\n")
        f.write(f"SPROMPT=$(cat '{sys_prompt_file}')\n")
        f.write(f"UPROMPT=$(cat '{user_prompt_file}')\n")
        f.write("claude -p \\\n")
        f.write("  --bare \\\n")
        f.write("  --permission-mode bypassPermissions \\\n")
        f.write('  --allowedTools "Edit,Read,Bash" \\\n')
        f.write(f"  --model {model} \\\n")
        f.write(f"  --max-budget-usd {budget} \\\n")
        f.write('  --append-system-prompt "$SPROMPT" \\\n')
        f.write('  "$UPROMPT" \\\n')
        f.write(f"  > '{result_file}' 2>&1\n")
        f.write(f"RC=$?\n")
        f.write(f"if [ $RC -eq 0 ]; then\n")
        f.write(f"  echo 'done' > '{status_file}'\n")
        f.write(f"else\n")
        f.write(f"  echo 'failed' > '{status_file}'\n")
        f.write(f"fi\n")
    os.chmod(wrapper_script, 0o755)

    try:
        subprocess.Popen(
            ["/usr/bin/env", "bash", wrapper_script],
            cwd=PROJECT_DIR,
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        with open(status_file, "w") as f:
            f.write("failed")
        with open(result_file, "w") as f:
            f.write("Failed to spawn repair agent")
        log_event("spawn_failed", agent=agent_id, file=file_path)
        return None

    error_count = error_text.count("[E0") if error_text else 0
    log_event("spawn", agent=agent_id, file=os.path.basename(file_path),
              errors=error_count, model=model)
    return agent_id


# --- Task queue ---

def queue_task(file_path, error_text, step_hash):
    os.makedirs(QUEUE_DIR, exist_ok=True)
    task = {
        "file": file_path,
        "step_hash": step_hash,
        "queued_at": time.time(),
        "errors": error_text,
    }
    filename = f"{int(time.time())}-{step_hash}.json"
    with open(os.path.join(QUEUE_DIR, filename), "w") as f:
        json.dump(task, f)
    log_event("queued", file=os.path.basename(file_path), step=step_hash)


def drain_queue(config, agents):
    """If agents freed up, pull tasks from the queue and dispatch."""
    if not os.path.exists(QUEUE_DIR):
        return []

    working = count_working_agents(agents)
    max_agents = config.get("max_agents", 3)
    available_slots = max_agents - working

    if available_slots <= 0:
        return []

    messages = []
    queued_files = sorted(glob.glob(f"{QUEUE_DIR}/*.json"))

    for task_file in queued_files[:available_slots]:
        try:
            with open(task_file) as f:
                task = json.load(f)
            os.unlink(task_file)

            file_path = task["file"]
            error_text = task["errors"]
            step_hash = task["step_hash"]

            if agent_for_file(agents, file_path):
                continue

            log_event("dequeued", file=os.path.basename(file_path), step=step_hash)
            agent_id = spawn_agent(file_path, error_text, step_hash, config)
            if agent_id:
                messages.append(
                    f"REPAIR_AGENT_SPAWNED: {agent_id} handling queued errors "
                    f"in {os.path.basename(file_path)} (step:{step_hash})"
                )
                agents.append({
                    "id": agent_id, "status": "working",
                    "file": file_path, "step_hash": step_hash,
                    "dir": os.path.join(AGENTS_DIR, agent_id),
                })
        except Exception:
            continue

    return messages


# --- Status relay ---

def collect_status_updates(agents):
    """Collect status messages for the primary agent."""
    messages = []
    cleanup = []

    for a in agents:
        agent_dir = a["dir"]
        agent_id = a["id"]
        status = a["status"]
        target_file = os.path.basename(a.get("file") or "?")
        step_hash = a.get("step_hash", "?")

        if status == "needs-context":
            request_file = os.path.join(agent_dir, "request.md")
            question = ""
            if os.path.exists(request_file):
                with open(request_file) as f:
                    question = f.read().strip()
            messages.append(
                f"REPAIR_AGENT_NEEDS_CONTEXT: {agent_id} (step:{step_hash}) "
                f"fixing {target_file}\n  {question}\n"
                f"  Write context to: {agent_dir}/response.md"
            )
            log_event("needs_context", agent=agent_id, file=target_file)

        elif status == "done":
            result_file = os.path.join(agent_dir, "result.md")
            summary = ""
            if os.path.exists(result_file):
                with open(result_file) as f:
                    content = f.read().strip()
                summary_lines = content.split("\n")[:5]
                summary = "\n  ".join(summary_lines)

            task_file = os.path.join(agent_dir, "task.json")
            duration = None
            if os.path.exists(task_file):
                with open(task_file) as f:
                    task_data = json.load(f)
                spawned = task_data.get("spawned_at", 0)
                if spawned:
                    duration = round(time.time() - spawned, 1)

            messages.append(
                f"REPAIR_AGENT_DONE: {agent_id} finished on {target_file}\n  {summary}"
            )
            log_event("done", agent=agent_id, file=target_file,
                      duration_s=duration)
            cleanup.append(agent_dir)

        elif status == "failed":
            messages.append(
                f"REPAIR_AGENT_FAILED: {agent_id} could not fix {target_file}"
            )
            log_event("failed", agent=agent_id, file=target_file)
            cleanup.append(agent_dir)

    return messages, cleanup


def archive_agents(dirs):
    for d in dirs:
        status_file = os.path.join(d, "status")
        with open(status_file, "w") as f:
            f.write("archived")


# --- Main ---

def main():
    if len(sys.argv) < 2:
        sys.exit(0)

    config = load_pool_config()
    tool_input = sys.argv[1]
    file_path = get_file_path(tool_input)

    if not file_path or not any(file_path.endswith(ext) for ext in BEAGLE_EXTENSIONS):
        relay_only(config)
        return

    ensure_daemon_running()

    syntax_msg, has_syntax_errors = run_syntax_check(file_path)
    if has_syntax_errors:
        output_parts = [syntax_msg]
        agents = get_active_agents()
        status_msgs, cleanup_dirs = collect_status_updates(agents)
        output_parts.extend(status_msgs)
        if cleanup_dirs:
            archive_agents(cleanup_dirs)
        print("\n".join(output_parts))
        return

    ensure_daemon_watches(file_path)
    time.sleep(0.3)

    check_result = query_daemon(file_path)
    agents = get_active_agents()
    output_parts = []

    if check_result:
        error_text, error_count, auto_count = format_errors(check_result, file_path)

        if error_text:
            output_parts.append(error_text)

        non_auto_errors = error_count - auto_count
        if non_auto_errors > 0:
            existing = agent_for_file(agents, file_path)
            if existing:
                output_parts.append(
                    f"REPAIR_AGENT_ACTIVE: {existing} already handling "
                    f"{os.path.basename(file_path)}"
                )
            else:
                working = count_working_agents(agents)
                max_agents = config.get("max_agents", 3)

                if working < max_agents:
                    step_hash = make_step_hash(file_path)
                    agent_id = spawn_agent(file_path, error_text or "", step_hash, config)
                    if agent_id:
                        output_parts.append(
                            f"REPAIR_AGENT_SPAWNED: {agent_id} handling "
                            f"{non_auto_errors} errors in "
                            f"{os.path.basename(file_path)} (step:{step_hash}) "
                            f"[pool: {working + 1}/{max_agents}]"
                        )
                else:
                    step_hash = make_step_hash(file_path)
                    queue_task(file_path, error_text or "", step_hash)
                    queued = len(glob.glob(f"{QUEUE_DIR}/*.json"))
                    output_parts.append(
                        f"REPAIR_POOL_FULL: {os.path.basename(file_path)} queued "
                        f"({queued} in queue, {max_agents} agents active)"
                    )

    cascade_msgs = check_cascade(file_path, config, agents)
    output_parts.extend(cascade_msgs)

    status_msgs, cleanup_dirs = collect_status_updates(agents)
    output_parts.extend(status_msgs)

    if cleanup_dirs:
        archive_agents(cleanup_dirs)
        agents = get_active_agents()
        drain_msgs = drain_queue(config, agents)
        output_parts.extend(drain_msgs)

    if output_parts:
        print("\n".join(output_parts))


def check_cascade(edited_file, config, agents):
    """Check sibling .bgl/.rkt files for cascade errors caused by editing edited_file."""
    file_dir = os.path.dirname(edited_file)
    siblings = glob.glob(os.path.join(file_dir, "*.bgl")) + glob.glob(os.path.join(file_dir, "*.rkt"))
    siblings = [s for s in siblings if os.path.abspath(s) != os.path.abspath(edited_file)]

    if not siblings:
        return []

    messages = []
    working = count_working_agents(agents)
    max_agents = config.get("max_agents", 3)

    for sib in siblings:
        if working >= max_agents:
            break

        if agent_for_file(agents, sib):
            continue

        result = query_daemon(sib)
        if not result:
            continue

        error_text, error_count, auto_count = format_errors(result, sib)
        non_auto = error_count - auto_count
        if non_auto > 0:
            step_hash = make_step_hash(sib)
            agent_id = spawn_agent(sib, error_text or "", step_hash, config)
            if agent_id:
                working += 1
                agents.append({
                    "id": agent_id, "status": "working",
                    "file": sib, "step_hash": step_hash,
                    "dir": os.path.join(AGENTS_DIR, agent_id),
                })
                messages.append(
                    f"REPAIR_AGENT_SPAWNED: {agent_id} handling cascade errors "
                    f"in {os.path.basename(sib)} (step:{step_hash}) "
                    f"[pool: {working}/{max_agents}]"
                )
                log_event("cascade_detected", source=os.path.basename(edited_file),
                          target=os.path.basename(sib), errors=non_auto)

    return messages


def relay_only(config):
    """For non-beagle edits, relay agent statuses and drain queue."""
    agents = get_active_agents()
    output_parts = []

    status_msgs, cleanup_dirs = collect_status_updates(agents)
    output_parts.extend(status_msgs)

    if cleanup_dirs:
        archive_agents(cleanup_dirs)
        agents = get_active_agents()
        drain_msgs = drain_queue(config, agents)
        output_parts.extend(drain_msgs)

    if output_parts:
        print("\n".join(output_parts))


if __name__ == "__main__":
    main()
