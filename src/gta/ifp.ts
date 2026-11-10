/**
 * Animation packages (.ifp, version 3 "ANP3" used by GTA SA).
 * Library name = package name (what ApplyAnimation takes), plus each animation's bone tracks.
 */

export interface Keyframe {
    time: number; // seconds
    rot: [number, number, number, number]; // quaternion x, y, z, w
    pos?: [number, number, number];
}

export interface BoneTrack {
    name: string;
    boneId: number;
    frames: Keyframe[];
}

export interface Animation {
    name: string;
    duration: number;
    bones: BoneTrack[];
}

export interface AnimPackage {
    name: string;
    animations: Animation[];
}

function cstr(buf: Buffer, at: number, len: number): string {
    const s = buf.toString('latin1', at, at + len);
    const z = s.indexOf('\0');
    return z >= 0 ? s.slice(0, z) : s;
}

/** Parses an ANP3 package. `withFrames = false` only reads names (fast listing). */
export function parseIfp(buf: Buffer, withFrames = true): AnimPackage {
    if (buf.toString('latin1', 0, 4) !== 'ANP3') throw new Error('unsupported IFP (only ANP3 / GTA SA)');
    const name = cstr(buf, 8, 24);
    const count = buf.readUInt32LE(32);
    let p = 36;
    const animations: Animation[] = [];
    for (let a = 0; a < count && p + 36 <= buf.length; a++) {
        const animName = cstr(buf, p, 24);
        const numBones = buf.readUInt32LE(p + 24);
        const dataSize = buf.readUInt32LE(p + 28);
        const compressed = buf.readUInt32LE(p + 32) !== 0;
        p += 36;
        const bones: BoneTrack[] = [];
        let duration = 0;
        const endOfAnim = p + numBones * 36 + dataSize;
        for (let b = 0; b < numBones && p + 36 <= buf.length; b++) {
            const boneName = cstr(buf, p, 24);
            const frameType = buf.readUInt32LE(p + 24); // 3 = rotation, 4 = rotation + translation
            const numFrames = buf.readUInt32LE(p + 28);
            const boneId = buf.readInt32LE(p + 32);
            p += 36;
            const withPos = frameType === 4;
            const frameSize = compressed ? (withPos ? 16 : 10) : withPos ? 32 : 20;
            const frames: Keyframe[] = [];
            if (withFrames) {
                for (let f = 0; f < numFrames; f++) {
                    const o = p + f * frameSize;
                    if (o + frameSize > buf.length) break;
                    if (compressed) {
                        const rot: Keyframe['rot'] = [
                            buf.readInt16LE(o) / 4096,
                            buf.readInt16LE(o + 2) / 4096,
                            buf.readInt16LE(o + 4) / 4096,
                            buf.readInt16LE(o + 6) / 4096,
                        ];
                        const time = buf.readInt16LE(o + 8) / 60;
                        const pos: Keyframe['pos'] = withPos
                            ? [buf.readInt16LE(o + 10) / 1024, buf.readInt16LE(o + 12) / 1024, buf.readInt16LE(o + 14) / 1024]
                            : undefined;
                        frames.push({ time, rot, pos });
                    } else {
                        const rot: Keyframe['rot'] = [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8), buf.readFloatLE(o + 12)];
                        const time = buf.readFloatLE(o + 16);
                        const pos: Keyframe['pos'] = withPos ? [buf.readFloatLE(o + 20), buf.readFloatLE(o + 24), buf.readFloatLE(o + 28)] : undefined;
                        frames.push({ time, rot, pos });
                    }
                }
                if (frames.length) duration = Math.max(duration, frames[frames.length - 1].time);
            }
            p += numFrames * frameSize;
            bones.push({ name: boneName, boneId, frames });
        }
        if (!withFrames) p = endOfAnim;
        animations.push({ name: animName, duration, bones });
    }
    return { name, animations };
}
