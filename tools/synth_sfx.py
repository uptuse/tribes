"""
R32.13.1 — Procedural SFX synthesis for Tribes Raindance.
Outputs 16-bit mono WAV files at 44.1kHz suitable for direct decode by WebAudio.

Tribes-signature targets:
  - Spinfusor: deep "thwoomp" — strong sub thump + downward pitch sweep + brassy ring
  - Chaingun:  rapid mechanical pop with bass body
  - Disc impact: huge subby BOOM with metallic shrapnel crack
  - Lightning: ionized rip + body rumble + branch crackles
  - Ski: wide-band frictionless rush, looped, distinct from jet
  - Hard landing: meaty body thud + armor crunch
"""
import numpy as np
import wave
import os

SR = 44100
OUT_DIR = "/home/ubuntu/tribes/assets/audio/sfx"
os.makedirs(OUT_DIR, exist_ok=True)


def write_wav(path, samples, sr=SR):
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"  wrote {path}  ({len(samples)/sr:.2f}s, {os.path.getsize(path)/1024:.1f} KB)")


def lowpass(x, n_avg):
    """Simple boxcar lowpass — bigger n = lower cutoff."""
    return np.convolve(x, np.ones(n_avg)/n_avg, mode='same')


def highpass(x, n_avg):
    """x minus its lowpass = highpass."""
    return x - lowpass(x, n_avg)


def bandpass(x, lo_n, hi_n):
    """Lowpass at hi_n then highpass at lo_n."""
    return highpass(lowpass(x, hi_n), lo_n)


# ===========================================================================
# 1. SPINFUSOR / DISC FIRE — A/B DIAGNOSTIC VARIANT (R32.13.4)
# ===========================================================================
# User reports still hearing a "ping" in-game. To isolate whether the disc
# launcher is the source, this generator now produces a RADICALLY different
# sound: pure low-frequency mortar whump with NO content above ~600 Hz at all.
# If the ping persists after this change, the disc launcher is NOT the source.
#
# Composition (intentionally minimal & all-bass):
#   (a) ultra-fast air puff (LP-filtered noise, no HP content)
#   (b) deep sub thump 65 Hz -> 32 Hz exponential sweep, single sine, no
#       harmonics (so no octave/3rd that could read as pitched ringing)
#   (c) low-mid body rumble bandpassed 80–300 Hz
#   (d) AGGRESSIVE final lowpass (n_avg=24, ~900 Hz cutoff) on the entire
#       summed signal — guarantees the file has effectively zero energy in
#       the 1–8 kHz region where pings live.
def make_disc_fire():
    dur = 0.55
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)

    # (a) Air puff — broadband noise, immediately LP'd so it's a "whuff" not a
    # crack. No HP component anywhere. ~5 ms attack, ~40 ms decay.
    puff = np.random.normal(0, 1, n)
    puff = lowpass(puff, 30)  # cutoff ~700 Hz
    puff_env = np.exp(-t * 35) * (1 - np.exp(-t * 1200))
    sig += puff * puff_env * 0.55

    # (b) Deep mortar sub: 65 Hz -> 32 Hz exponential sweep, pure sine only.
    f_low, f_extra, tau = 32.0, 33.0, 0.07
    phase = 2 * np.pi * (f_low * t - tau * f_extra * np.exp(-t/tau) + tau * f_extra)
    sub_env = np.exp(-t * 4.5) * (1 - np.exp(-t * 220))
    sub = np.sin(phase) * sub_env
    sig += sub * 1.05  # dominant

    # (c) Low-mid body rumble — bandpass 80–300 Hz, gives chest-feel without
    # contributing anything above 300 Hz.
    rumble = np.random.normal(0, 1, n)
    rumble = bandpass(rumble, 150, 24)  # narrow low band
    rumble_env = np.exp(-t * 7) * (1 - np.exp(-t * 200))
    sig += rumble * rumble_env * 0.35

    # (d) Belt-and-braces global lowpass to guarantee no high-frequency residue.
    # n_avg=24 boxcar -> approx -3dB at ~SR/(2*24) ≈ 920 Hz, with steep rolloff
    # above. Anything above ~1.5 kHz will be effectively silent.
    sig = lowpass(sig, 24)

    # Final touches: tail fade, normalize
    fade_n = int(0.05 * SR)
    sig[-fade_n:] *= np.linspace(1, 0, fade_n)
    sig = sig / np.max(np.abs(sig)) * 0.96
    write_wav(f"{OUT_DIR}/disc_fire.wav", sig)


# ===========================================================================
# 2. DISC IMPACT — the huge BOOM when the disc explodes
# ===========================================================================
# Layered: deep sub-explosion thud + metallic shrapnel crack + high sizzle tail.
def make_disc_impact():
    dur = 0.85
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)

    # Sub thump: 80Hz -> 28Hz
    f0, f_extra, tau = 28.0, 52.0, 0.06
    phase = 2 * np.pi * (f0 * t - tau * f_extra * np.exp(-t/tau) + tau * f_extra)
    sub_env = np.exp(-t * 3.8) * (1 - np.exp(-t * 250))
    sub = np.sin(phase) * sub_env
    sub += 0.35 * np.sin(2 * phase) * sub_env  # warmth
    sig += sub * 0.85

    # Metallic shrapnel — sharp HP noise transient
    shrap = np.random.normal(0, 1, n)
    shrap = highpass(shrap, 10)
    shrap_env = np.exp(-t * 28) * (1 - np.exp(-t * 1500))
    sig += shrap * shrap_env * 0.45

    # Mid crunch: bandpassed for "debris/rubble"
    crunch = np.random.normal(0, 1, n)
    crunch = bandpass(crunch, 40, 8)
    crunch_env = np.exp(-t * 6) * (1 - np.exp(-t * 250))
    sig += crunch * crunch_env * 0.4

    # High sizzle tail (smoke/embers)
    sizzle = np.random.normal(0, 1, n)
    sizzle = highpass(sizzle, 18)
    sizzle_env = np.exp(-t * 2.2) * (1 - np.exp(-t * 100))
    sig += sizzle * sizzle_env * 0.18

    fade_n = int(0.06 * SR)
    sig[-fade_n:] *= np.linspace(1, 0, fade_n)
    sig = sig / np.max(np.abs(sig)) * 0.96
    write_wav(f"{OUT_DIR}/disc_impact.wav", sig)


# ===========================================================================
# 3. CHAINGUN — single round (game loops/rapid-fires it)
# ===========================================================================
# Real chaingun rounds: SHARP crack + brief sub body + brassy resonant tonal.
def make_chaingun():
    dur = 0.13
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)

    # Crack: HP noise burst, very fast attack/decay
    crack = np.random.normal(0, 1, n)
    crack = highpass(crack, 8)
    crack_env = np.exp(-t * 60) * (1 - np.exp(-t * 2500))
    sig += crack * crack_env * 0.85

    # Body: sub-blip 110Hz with fast decay
    body = np.sin(2 * np.pi * 110 * t) * np.exp(-t * 45) * 0.55
    body += np.sin(2 * np.pi * 165 * t) * np.exp(-t * 60) * 0.25
    sig += body

    # R32.13.3: 1.2kHz brass resonance REMOVED — read as a PING. The crack +
    # sub-body now carry the full chaingun character; we add a brief mid
    # bandpassed mechanism rattle for body without any pitched component.
    rattle = np.random.normal(0, 1, n)
    rattle = bandpass(rattle, 30, 12)  # ~250-1100Hz
    rattle_env = np.exp(-t * 90) * (1 - np.exp(-t * 1500))
    sig += rattle * rattle_env * 0.30

    sig = sig / np.max(np.abs(sig)) * 0.94
    write_wav(f"{OUT_DIR}/chaingun.wav", sig)


# ===========================================================================
# 4. LIGHTNING CRACK
# ===========================================================================
def make_lightning_crack():
    dur = 1.6
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)

    rip = np.random.normal(0, 1, n)
    rip = highpass(rip, 4)
    rip_env = np.exp(-t * 18) * (1 - np.exp(-t * 400))
    sig += rip * rip_env * 0.7

    rumble = np.random.normal(0, 1, n)
    rumble = lowpass(rumble, 16)
    rumble_env = np.exp(-t * 2.5) * (1 - np.exp(-t * 30))
    sig += rumble * rumble_env * 0.55

    rng = np.random.default_rng(42)
    for _ in range(int(rng.integers(8, 14))):
        pop_t = rng.uniform(0.05, 0.85)
        pop_n = int(pop_t * SR)
        pop_dur = int(0.025 * SR)
        if pop_n + pop_dur >= n: continue
        pop_env = np.exp(-np.arange(pop_dur) / pop_dur * 12)
        pop = np.random.normal(0, 1, pop_dur) * pop_env * rng.uniform(0.3, 0.7)
        sig[pop_n:pop_n + pop_dur] += pop

    fade_n = int(0.05 * SR)
    sig[-fade_n:] *= np.linspace(1, 0, fade_n)
    sig = sig / np.max(np.abs(sig)) * 0.92
    write_wav(f"{OUT_DIR}/lightning_crack.wav", sig)


# ===========================================================================
# 5. SKI RUSH — looping
# ===========================================================================
def make_ski_rush():
    dur = 1.5
    n = int(dur * SR)
    t = np.arange(n) / SR
    base = np.random.normal(0, 1, n)
    body = lowpass(base, 6) * 0.4 + highpass(base, 120) * 0.55
    rumble = np.sin(2 * np.pi * 80 * t + np.sin(2 * np.pi * 0.7 * t) * 0.4) * 0.08
    rumble += np.random.normal(0, 1, n) * 0.04 * np.exp(-((t - 0.75) ** 2) / 0.5)
    wobble = 0.85 + 0.15 * np.sin(2 * np.pi * 1.3 * t + 0.5 * np.sin(2 * np.pi * 0.4 * t))
    sig = (body + rumble) * wobble
    fade_n = int(0.05 * SR)
    fade = np.linspace(0, 1, fade_n)
    sig[:fade_n] = sig[:fade_n] * fade + sig[-fade_n:] * (1 - fade)
    sig[-fade_n:] = sig[-fade_n:] * fade[::-1] + sig[:fade_n] * (1 - fade[::-1])
    sig = sig / np.max(np.abs(sig)) * 0.55
    write_wav(f"{OUT_DIR}/ski_rush.wav", sig)


# ===========================================================================
# 6. HARD LANDING
# ===========================================================================
def make_hard_landing():
    dur = 0.4
    n = int(dur * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 50 * t) * np.exp(-t * 9) * (1 - np.exp(-t * 250))
    body += np.sin(2 * np.pi * 75 * t) * np.exp(-t * 12) * 0.4
    body *= 0.85
    crunch = np.random.normal(0, 1, n)
    crunch = bandpass(crunch, 40, 5)
    crunch_env = np.exp(-t * 16) * (1 - np.exp(-t * 300))
    crunch *= crunch_env * 0.45
    sig = body + crunch
    fade_n = int(0.03 * SR)
    sig[-fade_n:] *= np.linspace(1, 0, fade_n)
    sig = sig / np.max(np.abs(sig)) * 0.95
    write_wav(f"{OUT_DIR}/hard_landing.wav", sig)


if __name__ == "__main__":
    print("R32.13.1 — Synthesizing Tribes-signature SFX...")
    make_disc_fire()
    make_disc_impact()
    make_chaingun()
    make_lightning_crack()
    make_ski_rush()
    make_hard_landing()
    print("Done.")
