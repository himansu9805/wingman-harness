"use strict";

const { spawn, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const { StringDecoder } = require("node:string_decoder");
const { randomUUID } = require("node:crypto");
const pty = require("node-pty");

const MAX_REQUEST_BYTES = 1024 * 1024;
const heartbeatTimeout = Number(process.env.WINGMAN_PTY_HEARTBEAT_MS || 30000);
const directory = mkdtempSync(join(tmpdir(), "wingman-pty-"));
const fifo = join(directory, "completion");
const fifoResult = spawnSync("mkfifo", ["-m", "600", fifo]);
if (fifoResult.status !== 0) {
  rmSync(directory, { recursive: true, force: true });
  throw new Error("Could not create completion channel");
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const control = spawn("cat", [fifo], { stdio: ["ignore", "pipe", "pipe"] });
let terminal;
try {
  terminal = pty.spawn(
    "bash",
    ["--noprofile", "--norc", "-c", "stty -echo; exec bash --noprofile --norc --noediting -i"],
    {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      encoding: null,
      env: {
        ...process.env,
        PS1: "",
        PS2: "",
        PROMPT_COMMAND: "",
        HISTFILE: "/dev/null",
        HISTSIZE: "0",
        HISTFILESIZE: "0",
      },
    },
  );
} catch (error) {
  control.kill("SIGTERM");
  rmSync(directory, { recursive: true, force: true });
  throw error;
}
const decoder = new StringDecoder("utf8");
let active;
let pending = Buffer.alloc(0);
let input = Buffer.alloc(0);
let closed = false;
let ready = false;
let lastHeartbeat = Date.now();
let outputPaused = false;

function emit(event) {
  if (!process.stdout.write(`${JSON.stringify(event)}\n`) && !outputPaused) {
    outputPaused = true;
    terminal.pause();
    process.stdout.once("drain", () => {
      outputPaused = false;
      if (!closed) terminal.resume();
    });
  }
}
function output(bytes, id) {
  const text = decoder.write(bytes);
  if (text) emit({ type: "command.output", id, text });
}
function finish() {
  if (!active || !active.markerSeen || active.exitCode === undefined) return;
  rmSync(active.file, { force: true });
  emit({ type: "command.completed", id: active.id, exitCode: active.exitCode });
  active = undefined;
}
function shutdown(reason, report = true) {
  if (closed) return;
  closed = true;
  clearInterval(heartbeat);
  if (report && active) emit({ type: "command.uncertain", id: active.id, reason });
  if (report) emit({ type: "session.closed", reason });
  // Linux exposes the controlling terminal's foreground group in /proc.
  // It may differ from Bash's group while a command is running.
  const groups = new Set([terminal.pid]);
  try {
    const stat = readFileSync(`/proc/${terminal.pid}/stat`, "utf8");
    const foreground = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[5]);
    if (Number.isInteger(foreground) && foreground > 0) groups.add(foreground);
  } catch {
    /* The shell may have already exited. */
  }
  for (const group of groups) {
    try {
      process.kill(-group, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  }
  try {
    terminal.kill("SIGTERM");
  } catch {
    /* Already exited. */
  }
  control.kill("SIGTERM");
  rmSync(directory, { recursive: true, force: true });
  process.stdin.pause();
  const timer = setTimeout(() => {
    for (const group of groups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
    process.exit(0);
  }, 1000);
  timer.unref();
}
terminal.onData((chunk) => {
  if (closed) return;
  pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
  if (!active || active.markerSeen) {
    output(pending, null);
    pending = Buffer.alloc(0);
    return;
  }
  const position = pending.indexOf(active.marker);
  if (position >= 0) {
    output(pending.subarray(0, position), active.id);
    const tail = decoder.end();
    if (tail) emit({ type: "command.output", id: active.id, text: tail });
    pending = pending.subarray(position + active.marker.length);
    active.markerSeen = true;
    if (pending.length) output(pending, null);
    pending = Buffer.alloc(0);
    finish();
    return;
  }
  let keep = Math.min(pending.length, active.marker.length - 1);
  while (keep && !pending.subarray(-keep).equals(active.marker.subarray(0, keep))) keep--;
  output(keep ? pending.subarray(0, -keep) : pending, active.id);
  pending = keep ? pending.subarray(-keep) : Buffer.alloc(0);
});
terminal.onExit(() => {
  if (!closed) {
    if (pending.length) output(pending, active?.id ?? null);
    const tail = decoder.end();
    if (tail) emit({ type: "command.output", id: active?.id ?? null, text: tail });
  }
  shutdown("shell exited");
});
control.on("error", () => shutdown("completion channel failed"));
control.on("exit", () => shutdown("completion channel closed"));
createInterface({ input: control.stdout }).on("line", (line) => {
  if (closed) return;
  if (!ready && line === "READY") {
    ready = true;
    emit({ type: "session.ready" });
    return;
  }
  const match = /^([a-zA-Z0-9-]{1,64}) (\d{1,3})$/.exec(line);
  if (
    !match ||
    !active ||
    match[1] !== active.id ||
    Number(match[2]) > 255 ||
    active.exitCode !== undefined
  ) {
    emit({ type: "session.error", reason: "invalid completion message" });
    shutdown("invalid completion message", false);
    return;
  }
  active.exitCode = Number(match[2]);
  finish();
});
const heartbeat = setInterval(
  () => {
    if (Date.now() - lastHeartbeat >= heartbeatTimeout) shutdown("controller heartbeat expired");
  },
  Math.min(1000, heartbeatTimeout),
);
heartbeat.unref();
function handle(request) {
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new Error("invalid request");
  if (request.type === "ping") {
    lastHeartbeat = Date.now();
    return;
  }
  if (request.type === "close") {
    shutdown("closed by controller");
    return;
  }
  if (request.type === "resize") {
    if (
      !Number.isInteger(request.cols) ||
      !Number.isInteger(request.rows) ||
      request.cols < 20 ||
      request.cols > 500 ||
      request.rows < 5 ||
      request.rows > 200
    )
      throw new Error("invalid dimensions");
    terminal.resize(request.cols, request.rows);
    emit({ type: "session.resized", cols: request.cols, rows: request.rows });
    return;
  }
  if (
    request.type !== "execute" ||
    typeof request.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,64}$/.test(request.id) ||
    typeof request.command !== "string" ||
    request.command.includes("\0")
  )
    throw new Error("invalid request");
  if (active) {
    emit({ type: "command.rejected", id: request.id, reason: "session busy" });
    return;
  }
  const file = join(directory, `command-${randomUUID()}`);
  writeFileSync(file, request.command, { mode: 0o600, flag: "wx" });
  active = {
    id: request.id,
    file,
    marker: Buffer.from(`\x1b]777;wingman;${request.id}\x07`),
    markerSeen: false,
  };
  const wrapper = `builtin set +o history; builtin history -c; builtin source ${quote(file)} 8>&-; builtin printf '%s %s\\n' ${quote(request.id)} "$?" >&8; builtin printf '\\033]777;wingman;%s\\007' ${quote(request.id)} > /dev/tty\n`;
  terminal.write(wrapper);
  emit({ type: "command.started", id: request.id });
}
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (!closed) {
    const end = input.indexOf(10);
    if (end < 0) break;
    if (end + 1 > MAX_REQUEST_BYTES) {
      emit({ type: "session.error", reason: "request too large" });
      shutdown("request too large", false);
      return;
    }
    const line = input.subarray(0, end);
    input = input.subarray(end + 1);
    try {
      handle(JSON.parse(line.toString("utf8")));
    } catch {
      emit({ type: "session.error", reason: "invalid request" });
      shutdown("invalid request", false);
    }
  }
  if (input.length >= MAX_REQUEST_BYTES) {
    emit({ type: "session.error", reason: "request too large" });
    shutdown("request too large", false);
  }
});
process.stdout.on("error", () => shutdown("controller output failed", false));
process.stdin.on("end", () => shutdown("controller disconnected", false));
process.stdin.on("error", () => shutdown("controller input failed", false));
terminal.write(`exec 8>${quote(fifo)}; builtin printf 'READY\\n' >&8\n`);
