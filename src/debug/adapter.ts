/**
 * Built-in debug adapter (DAP) for SA-MP / open.mp.
 *
 * The SA-MP server has no real debugger (no breakpoints/stepping). What can be done — and what
 * matters day to day — is:
 *   - compile and start the server with one click;
 *   - show the live log in the Debug Console;
 *   - when crashdetect reports an error, "stop" at the exact line, with the call stack and
 *     each function's arguments in the Variables view (the server keeps running);
 *   - send RCON / console commands through the REPL.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { readServerCfgValue, ServerInfo } from '../packages/manifest';
import { t } from '../i18n';
import { errorHint, LogParser, RuntimeError, RuntimeFrame } from './crashdetect';
import { sendRcon } from './rcon';

export interface LaunchArgs {
    serverPath?: string;
    compile?: boolean;
    target?: string;
    args?: string[];
    logFile?: string;
    stopOnError?: boolean;
}

export interface DebugHooks {
    compileForLaunch(target?: string): Promise<{ ok: boolean; message?: string; amx?: string } | undefined>;
    findServer(explicit?: string): ServerInfo | undefined;
    resolveSource(file: string): string | undefined;
    onRuntimeError(err: RuntimeError, frames: Array<RuntimeFrame & { resolved?: string }>): void;
    onServerState(state: { running: boolean; server?: ServerInfo; pid?: number }): void;
    hasCrashdetect(server: ServerInfo): boolean;
}

type Msg = { seq: number; type: string; command?: string; arguments?: any; event?: string; body?: any };

const THREAD_ID = 1;

export class PawnDebugSession implements vscode.DebugAdapter {
    private emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
    readonly onDidSendMessage = this.emitter.event;

    private seq = 1;
    private proc: cp.ChildProcess | undefined;
    private server: ServerInfo | undefined;
    private tailTimer: NodeJS.Timeout | undefined;
    private flushTimer: NodeJS.Timeout | undefined;
    private parser = new LogParser();
    private stopped: { err: RuntimeError; frames: Array<RuntimeFrame & { resolved?: string }> } | undefined;
    private breakOnErrors = true;
    private terminated = false;
    private varRefs = new Map<number, Array<{ name: string; value: string }>>();

    constructor(private hooks: DebugHooks) {}

    dispose(): void {
        this.shutdown();
        this.emitter.dispose();
    }

    handleMessage(message: vscode.DebugProtocolMessage): void {
        const msg = message as Msg;
        if (msg.type !== 'request') return;
        this.dispatch(msg).catch((e) => this.respond(msg, undefined, false, String(e?.message ?? e)));
    }

    // ───────────────────────── protocol ─────────────────────────

    private send(m: Record<string, unknown>): void {
        this.emitter.fire({ seq: this.seq++, ...m } as vscode.DebugProtocolMessage);
    }

    private respond(req: Msg, body?: unknown, success = true, message?: string): void {
        this.send({ type: 'response', request_seq: req.seq, command: req.command, success, message, body });
    }

    private event(event: string, body?: unknown): void {
        this.send({ type: 'event', event, body });
    }

    private out(text: string, category: 'console' | 'stdout' | 'stderr' | 'important' = 'console'): void {
        this.event('output', { category, output: text.endsWith('\n') ? text : text + '\n' });
    }

    private async dispatch(req: Msg): Promise<void> {
        const a = req.arguments ?? {};
        switch (req.command) {
            case 'initialize':
                this.respond(req, {
                    supportsConfigurationDoneRequest: true,
                    supportsTerminateRequest: true,
                    supportsExceptionInfoRequest: true,
                    supportsEvaluateForHovers: false,
                    exceptionBreakpointFilters: [
                        { filter: 'runtime', label: t('Runtime errors (crashdetect)'), default: true },
                    ],
                });
                this.event('initialized');
                return;
            case 'launch':
                return this.launch(req, a as LaunchArgs);
            case 'configurationDone':
            case 'setBreakpoints':
            case 'setFunctionBreakpoints':
                this.respond(req, req.command === 'setBreakpoints' ? { breakpoints: [] } : undefined);
                return;
            case 'setExceptionBreakpoints':
                this.breakOnErrors = (a.filters ?? []).includes('runtime');
                this.respond(req);
                return;
            case 'threads':
                this.respond(req, {
                    threads: [{ id: THREAD_ID, name: this.server ? `${path.basename(this.server.executable ?? t('server'))}` : t('Server') }],
                });
                return;
            case 'stackTrace':
                return this.stackTrace(req);
            case 'scopes':
                return this.scopes(req, a.frameId);
            case 'variables':
                this.respond(req, {
                    variables: (this.varRefs.get(a.variablesReference) ?? []).map((v) => ({
                        name: v.name,
                        value: v.value,
                        variablesReference: 0,
                    })),
                });
                return;
            case 'exceptionInfo':
                return this.exceptionInfo(req);
            case 'continue':
                this.stopped = undefined;
                this.respond(req, { allThreadsContinued: true });
                this.event('continued', { threadId: THREAD_ID, allThreadsContinued: true });
                return;
            case 'pause':
            case 'next':
            case 'stepIn':
            case 'stepOut':
                this.respond(req, undefined, false, t('The SA-MP/open.mp server does not support pausing or stepping.'));
                return;
            case 'evaluate':
                return this.evaluate(req, a.expression ?? '', a.context);
            case 'terminate':
            case 'disconnect':
                this.shutdown();
                this.respond(req);
                if (!this.terminated) {
                    this.terminated = true;
                    this.event('terminated');
                }
                return;
            default:
                this.respond(req, undefined, false, t('unsupported command: {0}', String(req.command)));
        }
    }

    // ───────────────────────── launch ─────────────────────────

    private async launch(req: Msg, args: LaunchArgs): Promise<void> {
        if (args.stopOnError === false) this.breakOnErrors = false;
        const server = this.hooks.findServer(args.serverPath);
        if (!server?.executable) {
            this.respond(
                req,
                undefined,
                false,
                t('Server not found (samp-server.exe / omp-server.exe). Set "pawnStudio.server.path" or "serverPath" in launch.json.'),
            );
            return;
        }
        this.server = server;

        if (args.compile !== false) {
            this.out(t('Checking the gamemode before starting...'));
            const r = await this.hooks.compileForLaunch(args.target);
            if (!r) {
                this.respond(req, undefined, false, t('Compilation cancelled.'));
                return;
            }
            if (!r.ok) {
                this.respond(req, undefined, false, t('Compilation failed: {0}', r.message ?? t('see the Problems panel')));
                return;
            }
            this.out(`✔ ${r.message ?? t('compiled')}`);
            if (r.amx) this.checkGamemodeConfig(server, r.amx);
        }

        if (!this.hooks.hasCrashdetect(server)) {
            this.out(
                t('⚠ The crashdetect plugin is not installed: runtime errors will not show the source line.') +
                    '\n  ' +
                    t('Install it from the Pawn tab → Packages (search for "crashdetect") and compile with -d3.'),
                'important',
            );
        }

        const logFile = args.logFile
            ? path.resolve(server.dir, args.logFile)
            : path.join(server.dir, server.kind === 'openmp' ? 'log.txt' : 'server_log.txt');
        let offset = 0;
        try {
            offset = fs.statSync(logFile).size;
        } catch {
            offset = 0;
        }

        this.out(t('▶ Starting {0} in {1}', path.basename(server.executable), server.dir));
        const proc = cp.spawn(server.executable, args.args ?? [], { cwd: server.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        this.proc = proc;
        proc.stdout?.on('data', () => undefined); // drain it so the pipe does not block
        proc.stderr?.on('data', (b: Buffer) => this.out(b.toString('latin1'), 'stderr'));
        proc.on('error', (e) => {
            this.out(t('Failed to start the server: {0}', e.message), 'stderr');
            this.finish();
        });
        proc.on('exit', (code, signal) => {
            this.flushLog(logFile);
            this.out(signal ? t('■ Server stopped ({0})', signal) : t('■ Server stopped (code {0})', String(code)));
            this.finish();
        });
        this.hooks.onServerState({ running: true, server, pid: proc.pid });
        this.startTail(logFile, offset);
        this.respond(req);
    }

    private checkGamemodeConfig(server: ServerInfo, amx: string): void {
        const gm = readServerCfgValue(server, 'gamemode0');
        if (!gm) return;
        const name = gm.split(/\s+/)[0].replace(/\.amx$/i, '');
        const compiled = path.basename(amx).replace(/\.amx$/i, '');
        const inGamemodes = path.basename(path.dirname(amx)).toLowerCase() === 'gamemodes';
        if (inGamemodes && name.toLowerCase() !== compiled.toLowerCase()) {
            this.out(
                t('⚠ You compiled "{0}.amx", but {1} loads the gamemode "{2}".', compiled, path.basename(server.configFile), name),
                'important',
            );
        }
    }

    // ───────────────────────── log ─────────────────────────

    private tailOffset = 0;
    private tailRest = '';

    private startTail(file: string, offset: number): void {
        this.tailOffset = offset;
        this.tailRest = '';
        this.tailTimer = setInterval(() => this.flushLog(file), 200);
    }

    private flushLog(file: string): void {
        let size: number;
        try {
            size = fs.statSync(file).size;
        } catch {
            return;
        }
        if (size < this.tailOffset) this.tailOffset = 0; // log recreated
        if (size === this.tailOffset) return;
        const fd = fs.openSync(file, 'r');
        try {
            const buf = Buffer.alloc(size - this.tailOffset);
            fs.readSync(fd, buf, 0, buf.length, this.tailOffset);
            this.tailOffset = size;
            const text = this.tailRest + buf.toString('latin1');
            const lines = text.split(/\r?\n/);
            this.tailRest = lines.pop() ?? '';
            for (const l of lines) this.onLogLine(l);
        } finally {
            fs.closeSync(fd);
        }
    }

    private onLogLine(line: string): void {
        const isDebug = line.includes('[debug]');
        const isErr = isDebug || /\b(error|failed|falhou|erro)\b/i.test(line);
        this.out(line, isErr ? 'stderr' : 'stdout');
        for (const err of this.parser.feed(line)) this.onError(err);
        // crashdetect writes several lines in a row; close the error after a short silence.
        if (this.flushTimer) clearTimeout(this.flushTimer);
        if (this.parser.pending) {
            this.flushTimer = setTimeout(() => {
                const e = this.parser.flush();
                if (e) this.onError(e);
            }, 350);
        }
    }

    private onError(err: RuntimeError): void {
        const frames = err.frames.map((f) => ({ ...f, resolved: f.file ? this.hooks.resolveSource(f.file) : undefined }));
        this.hooks.onRuntimeError(err, frames);
        const hint = errorHint(err.code);
        if (err.kind === 'script' && !frames.length) {
            this.out(`  → ${hint ?? ''} ${t('Install crashdetect to see the exact line.')}`, 'important');
        }
        if (err.kind === 'plugin') return;
        if (!this.breakOnErrors) return;
        this.stopped = { err, frames };
        this.event('stopped', {
            reason: 'exception',
            description: err.title,
            text: hint ?? err.details[0],
            threadId: THREAD_ID,
            allThreadsStopped: true,
        });
    }

    // ───────────────────────── stack / variables ─────────────────────────

    private stackTrace(req: Msg): void {
        const s = this.stopped;
        if (!s) {
            this.respond(req, { stackFrames: [], totalFrames: 0 });
            return;
        }
        const frames = s.frames.length
            ? s.frames.map((f) => ({
                  id: f.index + 1,
                  name: f.native ? t('{0} (native)', f.func) : `${f.func}(${f.args.map((x) => x.name.replace(/\[\]$/, '')).join(', ')})`,
                  source: f.resolved ? { name: path.basename(f.resolved), path: f.resolved } : undefined,
                  line: f.line ?? 0,
                  column: 1,
                  presentationHint: f.native || !f.resolved ? 'subtle' : 'normal',
              }))
            : [{ id: 1, name: s.err.title, line: 0, column: 0, presentationHint: 'label' }];
        this.respond(req, { stackFrames: frames, totalFrames: frames.length });
    }

    private scopes(req: Msg, frameId: number): void {
        const s = this.stopped;
        const frame = s?.frames.find((f) => f.index + 1 === frameId);
        const scopes: unknown[] = [];
        this.varRefs.clear();
        if (frame?.args.length) {
            this.varRefs.set(frameId * 10 + 1, frame.args.map((a) => ({ name: a.name, value: a.value || '?' })));
            scopes.push({ name: t('Arguments'), variablesReference: frameId * 10 + 1, expensive: false });
        }
        if (s) {
            const info: Array<{ name: string; value: string }> = [{ name: t('error'), value: s.err.title }];
            const hint = errorHint(s.err.code);
            if (hint) info.push({ name: t('hint'), value: hint });
            s.err.details.forEach((d, i) => info.push({ name: t('detail {0}', i + 1), value: d }));
            if (frame?.address) info.push({ name: t('address'), value: '0x' + frame.address });
            this.varRefs.set(frameId * 10 + 2, info);
            scopes.push({ name: t('Error'), variablesReference: frameId * 10 + 2, expensive: false });
        }
        this.respond(req, { scopes });
    }

    private exceptionInfo(req: Msg): void {
        const s = this.stopped;
        if (!s) {
            this.respond(req, { exceptionId: '', breakMode: 'never' });
            return;
        }
        const hint = errorHint(s.err.code);
        this.respond(req, {
            exceptionId: s.err.code !== undefined ? `Run time error ${s.err.code}` : s.err.kind,
            description: [s.err.title, ...s.err.details, hint ? t('Hint: {0}', hint) : ''].filter(Boolean).join('\n'),
            breakMode: 'always',
            details: {
                message: s.err.title,
                stackTrace: s.frames.map((f) => `#${f.index} ${f.raw}`).join('\n'),
            },
        });
    }

    // ───────────────────────── REPL ─────────────────────────

    private async evaluate(req: Msg, expr: string, context?: string): Promise<void> {
        if (context !== 'repl' || !expr.trim()) {
            this.respond(req, { result: '', variablesReference: 0 });
            return;
        }
        const server = this.server;
        if (!server || !this.proc) {
            this.respond(req, undefined, false, t('The server is not running.'));
            return;
        }
        if (server.kind === 'openmp' && this.proc.stdin?.writable) {
            this.proc.stdin.write(expr.trim() + '\n');
            this.respond(req, { result: `> ${expr.trim()}`, variablesReference: 0 });
            return;
        }
        const pass = readServerCfgValue(server, 'rcon_password');
        const port = parseInt(readServerCfgValue(server, 'port') ?? '7777', 10);
        if (!pass || pass === 'changeme') {
            this.respond(req, undefined, false, t('Set an rcon_password (other than "changeme") in server.cfg to use the console.'));
            return;
        }
        try {
            const lines = await sendRcon('127.0.0.1', port, pass, expr.trim());
            this.respond(req, { result: lines.join('\n') || t('(no response)'), variablesReference: 0 });
        } catch (e) {
            this.respond(req, undefined, false, t('RCON failed: {0}', (e as Error).message));
        }
    }

    // ───────────────────────── shutdown ─────────────────────────

    private finish(): void {
        this.shutdown();
        if (!this.terminated) {
            this.terminated = true;
            this.event('terminated');
        }
    }

    private shutdown(): void {
        if (this.tailTimer) clearInterval(this.tailTimer);
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.tailTimer = this.flushTimer = undefined;
        if (this.proc && this.proc.exitCode === null) {
            try {
                this.proc.kill();
            } catch {
                /* already exited */
            }
        }
        if (this.proc) this.hooks.onServerState({ running: false, server: this.server });
        this.proc = undefined;
    }
}
