import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Command, InvalidArgumentError } from "commander";
import { defaultControlPlaneHost, defaultControlPlanePort } from "../../control-plane/contracts.js";
import { startControlPlaneServer } from "../../control-plane/server.js";
import { ControlPlaneStore } from "../../control-plane/state.js";

export function controlPlaneCommand(): Command {
  const command = new Command("control-plane").description("Run the localhost-only RunForge control plane.");
  command.addCommand(serveCommand());
  command.addCommand(startCommand());
  command.addCommand(stopCommand());
  command.addCommand(statusCommand());
  return command;
}

function common(command: Command): Command {
  return command.option("--host <host>", "loopback bind host", defaultControlPlaneHost)
    .option("--port <port>", "listen port", integer, defaultControlPlanePort)
    .option("--state-root <path>", "persistent state directory", defaultStateRoot());
}

function serveCommand(): Command {
  return common(new Command("serve").description("Serve in the foreground."))
    .action(async (opts) => {
      try {
        const instance = await startControlPlaneServer({ host: opts.host, port: opts.port, stateRoot: opts.stateRoot });
        console.log(`RunForge control plane: ${instance.url}`);
        await new Promise<void>((done) => {
          const close = () => void instance.close().finally(done);
          process.once("SIGINT", close); process.once("SIGTERM", close);
        });
      } catch (error) { throw invalid(error); }
    });
}

function startCommand(): Command {
  return common(new Command("start").description("Start a detached local service."))
    .action(async (opts) => {
      try {
        const store = new ControlPlaneStore(resolve(opts.stateRoot)); await store.initialize();
        const existing = await store.readServiceInfo(); const pid = Number(existing?.pid ?? 0);
        if (pid && alive(pid)) throw new Error(`Control plane is already running (pid ${pid}, ${String(existing?.url ?? "unknown URL")}).`);
        const logPath = join(resolve(opts.stateRoot), "service.log"); const log = await open(logPath, "a", 0o600);
        const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "control-plane", "serve", "--host", opts.host, "--port", String(opts.port), "--state-root", resolve(opts.stateRoot)], { detached: true, stdio: ["ignore", log.fd, log.fd] });
        child.unref(); await log.close();
        console.log(`RunForge control plane starting (pid ${child.pid}); log: ${logPath}`);
      } catch (error) { throw invalid(error); }
    });
}

function stopCommand(): Command {
  return new Command("stop").description("Stop the service recorded in the state directory.")
    .option("--state-root <path>", "persistent state directory", defaultStateRoot())
    .action(async (opts) => {
      try { const info = await new ControlPlaneStore(resolve(opts.stateRoot)).readServiceInfo(); const pid = Number(info?.pid ?? 0); if (!pid || !alive(pid)) { console.log("RunForge control plane is not running."); return; } process.kill(pid, "SIGTERM"); console.log(`Stopped RunForge control plane (pid ${pid}).`); }
      catch (error) { throw invalid(error); }
    });
}

function statusCommand(): Command {
  return new Command("status").description("Show recorded service status.")
    .option("--state-root <path>", "persistent state directory", defaultStateRoot())
    .action(async (opts) => { const info = await new ControlPlaneStore(resolve(opts.stateRoot)).readServiceInfo(); const pid = Number(info?.pid ?? 0); console.log(JSON.stringify({ running: Boolean(pid && alive(pid)), ...info }, null, 2)); });
}

function defaultStateRoot(): string { return join(homedir(), ".runforge", "control-plane"); }
function integer(value: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new InvalidArgumentError("port must be an integer from 0 to 65535"); return parsed; }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function invalid(error: unknown): InvalidArgumentError { return new InvalidArgumentError(error instanceof Error ? error.message : String(error)); }
