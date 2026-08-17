import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const REFRESH_INTERVAL_MS = 15_000;
const COMMAND_TIMEOUT_MS = 60_000;

type McpcStatus = "live" | "expired" | string;

interface McpcSession {
  name: string;
  status: McpcStatus;
  server: { url?: string; command?: string; args?: string[] };
  profileName?: string;
  createdAt?: string;
  lastConnectionAttemptAt?: string;
  lastSeenAt?: string;
  pid?: number;
  protocolVersion?: string;
  serverInfo?: { name?: string; title?: string; version?: string };
}

interface McpcData {
  sessions: McpcSession[];
  profiles: unknown[];
}

interface Theme {
  fg(color: "text" | "accent" | "muted" | "dim" | "success" | "warning" | "error" | "border" | "borderAccent", text: string): string;
  bg(color: "selectedBg" | "toolPendingBg", text: string): string;
  bold(text: string): string;
}

function formatAge(value?: string): string {
  if (!value) return "never";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return value;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function serverLabel(session: McpcSession): string {
  if (session.server.url) return session.server.url;
  return [session.server.command, ...(session.server.args ?? [])].filter(Boolean).join(" ");
}

async function mcpc(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("mcpc", args, {
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: process.env,
  });
}

async function getStatus(): Promise<McpcData> {
  const { stdout } = await mcpc(["--json"]);
  const data = JSON.parse(stdout) as McpcData;
  if (!Array.isArray(data.sessions)) throw new Error("mcpc returned an invalid status payload");
  return data;
}

class McpcPanel {
  private selected = 0;
  private busy = false;
  private message = "";

  constructor(
    private data: McpcData,
    private updatedAt: Date,
    private readonly theme: Theme,
    private readonly refresh: () => Promise<void>,
    private readonly restart: (session: McpcSession) => Promise<void>,
    private readonly reconnectAll: () => Promise<void>,
    private readonly remove: (session: McpcSession) => Promise<void>,
    private readonly removeAll: () => Promise<void>,
    private readonly reauth: (session: McpcSession) => Promise<void>,
    private readonly close: () => void,
  ) {}

  setData(data: McpcData, updatedAt: Date): void {
    this.data = data;
    this.updatedAt = updatedAt;
    this.selected = Math.min(this.selected, Math.max(0, data.sessions.length - 1));
  }

  setBusy(value: boolean, message = ""): void {
    this.busy = value;
    this.message = message;
  }

  handleInput(data: string): void {
    const sessions = this.data.sessions;
    if (matchesKey(data, Key.escape) || data === "q") return this.close();
    if (this.busy) return;
    if (matchesKey(data, Key.up) || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down) || data === "j") this.selected = Math.min(sessions.length - 1, this.selected + 1);
    else if (data === "r" && sessions[this.selected]) void this.restart(sessions[this.selected]);
    else if (data === "R") void this.reconnectAll();
    else if (data === "x" && sessions[this.selected]) void this.remove(sessions[this.selected]);
    else if (data === "X") void this.removeAll();
    else if (data === "a" && sessions[this.selected]?.server.url) void this.reauth(sessions[this.selected]);
    else if (data === "f") void this.refresh();
  }

  render(width: number): string[] {
    const t = this.theme;
    const sessions = this.data.sessions;
    const live = sessions.filter((session) => session.status === "live").length;
    const unhealthy = sessions.length - live;
    const lines = [
      t.fg("accent", t.bold("mcpc connections")) + t.fg("dim", `  · updated ${formatAge(this.updatedAt.toISOString())}`),
      t.fg(unhealthy ? "warning" : "success", `${live} live`) + t.fg("muted", ` · ${unhealthy} not live`),
      "",
    ];

    if (!sessions.length) lines.push(t.fg("muted", "No active mcpc sessions."));
    for (let index = 0; index < sessions.length; index++) {
      const session = sessions[index]!;
      const selected = index === this.selected;
      const isLive = session.status === "live";
      const mark = t.fg(isLive ? "success" : "warning", isLive ? "●" : "○");
      const status = t.fg(isLive ? "success" : "warning", session.status);
      const prefix = selected ? t.fg("accent", "› ") : "  ";
      let line = `${prefix}${mark} ${session.name}  ${status}`;
      if (selected) line = t.bg("selectedBg", line);
      lines.push(truncateToWidth(line, width));
    }

    const current = sessions[this.selected];
    if (current) {
      lines.push("");
      lines.push(truncateToWidth(t.fg("muted", serverLabel(current)), width));
      const detail = [
        current.profileName ? `OAuth: ${current.profileName}` : "no OAuth profile",
        `last seen: ${formatAge(current.lastSeenAt)}`,
        current.serverInfo?.version ? `v${current.serverInfo.version}` : undefined,
      ].filter(Boolean).join(" · ");
      lines.push(truncateToWidth(t.fg("dim", detail), width));
    }

    lines.push("");
    if (this.busy) lines.push(t.fg("accent", this.message || "Working…"));
    else {
      const authHint = current?.server.url ? "a re-auth  " : "";
      lines.push(t.fg("dim", `↑↓ select  r reconnect  R reconnect all  x remove  X remove all`));
      lines.push(t.fg("dim", `${authHint}f refresh  esc close`));
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
  let data: McpcData = { sessions: [], profiles: [] };
  let updatedAt = new Date(0);
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshing = false;
  let panel: McpcPanel | undefined;
  let requestRender: (() => void) | undefined;

  const statusText = (ctx: ExtensionContext): string => {
    const live = data.sessions.filter((session) => session.status === "live").length;
    const bad = data.sessions.length - live;
    const text = `mcpc ${live}●${bad ? ` ${bad}○` : ""}`;
    return ctx.ui.theme.fg(bad ? "warning" : "success", text);
  };

  const updateUi = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("mcpc", statusText(ctx));
    requestRender?.();
  };

  const refresh = async (ctx: ExtensionContext, quiet = false): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    try {
      data = await getStatus();
      updatedAt = new Date();
      panel?.setData(data, updatedAt);
      updateUi(ctx);
    } catch (error) {
      if (!quiet) ctx.ui.notify(`mcpc refresh failed: ${errorMessage(error)}`, "error");
      ctx.ui.setStatus("mcpc", ctx.ui.theme.fg("error", "mcpc unavailable"));
    } finally {
      refreshing = false;
      requestRender?.();
    }
  };

  const runRestart = async (ctx: ExtensionContext, session: McpcSession): Promise<void> => {
    panel?.setBusy(true, `Restarting ${session.name}…`);
    requestRender?.();
    try {
      await mcpc(["restart", session.name, "--json"]);
      ctx.ui.notify(`${session.name} restarted`, "info");
      await refresh(ctx, false);
    } catch (error) {
      ctx.ui.notify(`Restart failed for ${session.name}: ${errorMessage(error)}`, "error");
    } finally {
      panel?.setBusy(false);
      requestRender?.();
    }
  };

  const runReconnectAll = async (ctx: ExtensionContext): Promise<void> => {
    const sessions = [...data.sessions];
    if (!sessions.length) return;
    const confirmed = await ctx.ui.confirm(
      "Reconnect all mcpc sessions?",
      `This restarts all ${sessions.length} session(s) and loses their session state.`,
    );
    if (!confirmed) return;

    panel?.setBusy(true, `Reconnecting 0/${sessions.length}…`);
    requestRender?.();
    const failures: string[] = [];
    for (let index = 0; index < sessions.length; index++) {
      const session = sessions[index]!;
      panel?.setBusy(true, `Reconnecting ${index + 1}/${sessions.length}: ${session.name}…`);
      requestRender?.();
      try {
        await mcpc(["restart", session.name, "--json"]);
      } catch (error) {
        failures.push(`${session.name}: ${errorMessage(error)}`);
      }
    }
    await refresh(ctx, false);
    if (failures.length) ctx.ui.notify(`Reconnect all completed with ${failures.length} failure(s): ${failures.join("; ")}`, "error");
    else ctx.ui.notify(`Reconnected all ${sessions.length} mcpc sessions`, "info");
    panel?.setBusy(false);
    requestRender?.();
  };

  const runRemove = async (ctx: ExtensionContext, session: McpcSession): Promise<void> => {
    const confirmed = await ctx.ui.confirm(
      `Remove ${session.name}?`,
      "This closes and removes the selected mcpc session. Its OAuth profile is kept.",
    );
    if (!confirmed) return;

    panel?.setBusy(true, `Removing ${session.name}…`);
    requestRender?.();
    try {
      await mcpc(["close", session.name, "--json"]);
      await refresh(ctx, false);
      ctx.ui.notify(`Removed ${session.name}`, "info");
    } catch (error) {
      ctx.ui.notify(`Remove failed for ${session.name}: ${errorMessage(error)}`, "error");
    } finally {
      panel?.setBusy(false);
      requestRender?.();
    }
  };

  const runRemoveAll = async (ctx: ExtensionContext): Promise<void> => {
    const confirmed = await ctx.ui.confirm(
      "Remove all mcpc data?",
      "This permanently removes all mcpc sessions, OAuth profiles, and bridge logs. You will need to connect and log in again.",
    );
    if (!confirmed) return;

    panel?.setBusy(true, "Removing all mcpc sessions, profiles, and logs…");
    requestRender?.();
    try {
      await mcpc(["clean", "all", "--json"]);
      await refresh(ctx, false);
      ctx.ui.notify("Removed all mcpc sessions, profiles, and logs", "info");
    } catch (error) {
      ctx.ui.notify(`Remove all failed: ${errorMessage(error)}`, "error");
    } finally {
      panel?.setBusy(false);
      requestRender?.();
    }
  };

  const runReauth = async (ctx: ExtensionContext, session: McpcSession): Promise<void> => {
    if (!session.server.url) return;
    panel?.setBusy(true, `Waiting for OAuth login for ${session.name} in your browser…`);
    requestRender?.();
    try {
      await mcpc(["login", session.server.url, "--profile", session.profileName ?? "default"]);
      await mcpc(["restart", session.name, "--json"]);
      ctx.ui.notify(`${session.name} re-authenticated and restarted`, "info");
      await refresh(ctx, false);
    } catch (error) {
      ctx.ui.notify(`Re-auth failed for ${session.name}: ${errorMessage(error)}`, "error");
    } finally {
      panel?.setBusy(false);
      requestRender?.();
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    await refresh(ctx, true);
    refreshTimer = setInterval(() => void refresh(ctx, true), REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    panel = undefined;
    requestRender = undefined;
  });

  pi.registerCommand("mcpc", {
    description: "Show mcpc connection status and controls",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        await refresh(ctx);
        return;
      }
      await refresh(ctx, true);
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const close = () => done(undefined);
        panel = new McpcPanel(
          data, updatedAt, theme as Theme,
          () => refresh(ctx),
          (session) => runRestart(ctx, session),
          () => runReconnectAll(ctx),
          (session) => runRemove(ctx, session),
          () => runRemoveAll(ctx),
          (session) => runReauth(ctx, session),
          close,
        );
        requestRender = () => tui.requestRender();
        return {
          render: (width) => panel!.render(width),
          invalidate: () => panel!.invalidate(),
          handleInput: (input) => {
            panel!.handleInput(input);
            tui.requestRender();
          },
        };
      }, {
        overlay: true,
        overlayOptions: { width: "50%", minWidth: 48, maxHeight: "80%", anchor: "right-center", margin: 1 },
      });
      panel = undefined;
      requestRender = undefined;
    },
  });
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" && error.stderr.trim()) {
    return error.stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}
