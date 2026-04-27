"""
R32.12.3 — post-process TTS shazbot to sound like a yelled radio-comm
battle cry instead of a calm narrator. Chain:
  1. Pitch-shift up ~2 semitones for excitement (faster playback resample)
  2. Soft-clip distortion for shouted vocal-cord roughness
  3. High-pass + mild low-pass = radio-comm bandpass (300Hz-3.5kHz)
  4. Subtle reverb tail for "I'm in a battlefield" space
  5. Compress + limit so it cuts through the music mix
  6. Trim leading silence
"""
import numpy as np
import wave
import os

SR_TARGET = 44100
IN_PATH = "/home/ubuntu/tribes/assets/audio/voice/shazbot_raw.wav"
OUT_PATH = "/home/ubuntu/tribes/assets/audio/voice/shazbot.wav"


def read_wav(path):
    with wave.open(path, 'rb') as w:
        n = w.getnframes()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        raw = w.readframes(n)
    if sw == 2:
        x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 4:
        x = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        x = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        x = (x - 128) / 128.0
    if ch == 2:
        x = x.reshape(-1, 2).mean(axis=1)
    print(f"  read {path}  ({len(x)/sr:.2f}s, sr={sr})")
    return x, sr


def write_wav(path, samples, sr):
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"  wrote {path}  ({len(samples)/sr:.2f}s, {os.path.getsize(path)/1024:.1f} KB)")


def trim_silence(x, threshold=0.015):
    abs_x = np.abs(x)
    mask = abs_x > threshold
    if not mask.any():
        return x
    first = np.argmax(mask)
    last = len(x) - np.argmax(mask[::-1])
    # Keep a tiny bit of head/tail for natural attack
    pad = int(0.02 * SR_TARGET)
    return x[max(0, first - pad):min(len(x), last + pad)]


def resample_linear(x, src_sr, dst_sr):
    if src_sr == dst_sr:
        return x
    ratio = dst_sr / src_sr
    new_len = int(len(x) * ratio)
    src_idx = np.arange(new_len) / ratio
    src_idx_floor = np.clip(src_idx.astype(int), 0, len(x) - 2)
    frac = src_idx - src_idx_floor
    return x[src_idx_floor] * (1 - frac) + x[src_idx_floor + 1] * frac


def pitch_shift_resample(x, semitones):
    """Crude pitch shift via resample + duration restore."""
    factor = 2 ** (semitones / 12.0)
    # Resample at factor*sr to shift pitch up; resulting sample plays faster
    # but we then resample back to original SR to restore duration with new pitch.
    # Net effect: pitch up + length shortened by factor (acceptable for short shouts).
    intermediate_sr = int(SR_TARGET * factor)
    shifted = resample_linear(x, SR_TARGET, intermediate_sr)
    # Reinterpret shifted as if it were SR_TARGET samples — pitch goes up, length down.
    # That's fine for our use case.
    return shifted


def soft_clip(x, drive=2.5):
    """Tanh-based soft clipping for vocal-cord roughness."""
    return np.tanh(x * drive) / np.tanh(drive)


def one_pole_hp(x, cutoff_hz, sr):
    """Simple one-pole high-pass."""
    rc = 1.0 / (2 * np.pi * cutoff_hz)
    dt = 1.0 / sr
    alpha = rc / (rc + dt)
    y = np.zeros_like(x)
    prev_y = 0.0
    prev_x = 0.0
    for i in range(len(x)):
        y[i] = alpha * (prev_y + x[i] - prev_x)
        prev_y = y[i]
        prev_x = x[i]
    return y


def one_pole_lp(x, cutoff_hz, sr):
    """Simple one-pole low-pass."""
    rc = 1.0 / (2 * np.pi * cutoff_hz)
    dt = 1.0 / sr
    alpha = dt / (rc + dt)
    y = np.zeros_like(x)
    prev_y = 0.0
    for i in range(len(x)):
        y[i] = prev_y + alpha * (x[i] - prev_y)
        prev_y = y[i]
    return y


def add_reverb(x, sr, decay_s=0.4, mix=0.18):
    """Cheap reverb: a few delayed+attenuated copies."""
    delays_ms = [37, 71, 113, 167, 223, 311]
    out = x.copy()
    for d_ms in delays_ms:
        d_samples = int(d_ms * sr / 1000)
        if d_samples >= len(x):
            continue
        atten = np.exp(-d_ms / 1000 / decay_s) * mix
        delayed = np.zeros_like(x)
        delayed[d_samples:] = x[:-d_samples] * atten
        out += delayed
    return out


def compress(x, threshold=0.3, ratio=4.0):
    """Simple downward compressor for cut-through."""
    abs_x = np.abs(x)
    over = np.maximum(0, abs_x - threshold)
    gain_reduction = over * (1 - 1 / ratio)
    return np.sign(x) * (abs_x - gain_reduction)


def main():
    x, sr = read_wav(IN_PATH)
    if sr != SR_TARGET:
        x = resample_linear(x, sr, SR_TARGET)
    # 1. Pitch-shift up 2 semitones (excitement)
    x = pitch_shift_resample(x, semitones=2)
    # 2. Soft-clip distortion (vocal-cord roughness from yelling)
    x = soft_clip(x, drive=2.8)
    # 3. Radio-comm bandpass: HP at 280Hz, LP at 3.4kHz
    x = one_pole_hp(x, 280, SR_TARGET)
    x = one_pole_lp(x, 3400, SR_TARGET)
    # 4. Subtle reverb (battlefield space)
    x = add_reverb(x, SR_TARGET, decay_s=0.45, mix=0.20)
    # 5. Compress + limit for punch
    x = compress(x, threshold=0.28, ratio=5.0)
    # 6. Trim silence
    x = trim_silence(x)
    # 7. Normalize to 0.95
    peak = np.max(np.abs(x))
    if peak > 1e-6:
        x = x / peak * 0.95
    write_wav(OUT_PATH, x, SR_TARGET)
    # Cleanup raw file
    if os.path.exists(IN_PATH):
        os.remove(IN_PATH)
        print(f"  removed {IN_PATH}")


if __name__ == "__main__":
    main()
