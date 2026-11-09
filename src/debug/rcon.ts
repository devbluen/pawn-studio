/**
 * RCON over the SA-MP query protocol (UDP) — also accepted by open.mp.
 */
import * as dgram from 'dgram';

export function buildRconPacket(host: string, port: number, password: string, command: string): Buffer {
    const ip = host.split('.').map((n) => parseInt(n, 10) & 255);
    while (ip.length < 4) ip.push(0);
    const pass = Buffer.from(password, 'latin1');
    const cmd = Buffer.from(command, 'latin1');
    const buf = Buffer.alloc(11 + 2 + pass.length + 2 + cmd.length);
    buf.write('SAMP', 0, 'latin1');
    ip.forEach((b, i) => buf.writeUInt8(b, 4 + i));
    buf.writeUInt16LE(port, 8);
    buf.write('x', 10, 'latin1');
    buf.writeUInt16LE(pass.length, 11);
    pass.copy(buf, 13);
    buf.writeUInt16LE(cmd.length, 13 + pass.length);
    cmd.copy(buf, 15 + pass.length);
    return buf;
}

export function parseRconReply(msg: Buffer): string | undefined {
    if (msg.length < 13 || msg.toString('latin1', 0, 4) !== 'SAMP' || msg[10] !== 0x78) return undefined;
    const len = msg.readUInt16LE(11);
    return msg.toString('latin1', 13, 13 + len);
}

/** Sends a command and collects replies until `quietMs` passes without new packets. */
export function sendRcon(host: string, port: number, password: string, command: string, quietMs = 400): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const sock = dgram.createSocket('udp4');
        const lines: string[] = [];
        let timer: NodeJS.Timeout;
        const finish = () => {
            try {
                sock.close();
            } catch {
                /* already closed */
            }
            resolve(lines);
        };
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(finish, quietMs);
        };
        sock.on('message', (msg) => {
            const s = parseRconReply(msg);
            if (s !== undefined) lines.push(s);
            arm();
        });
        sock.on('error', (e) => {
            clearTimeout(timer);
            sock.close();
            reject(e);
        });
        const pkt = buildRconPacket(host, port, password, command);
        sock.send(pkt, port, host, (err) => {
            if (err) reject(err);
            else arm();
        });
    });
}
