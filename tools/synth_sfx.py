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
# 1. SPINFUSOR / DISC FIRE — the iconic Tribes "thwoomp"
# ===========================================================================
# What makes it: (a) initial mechanical "click" of the launcher releasing,
# (b) DEEP downward pitch sweep ~180Hz -> 45Hz over ~150ms (the THWOOMP),
# (c) brassy harmonic ring on top (550Hz w/ 2nd harmonic), (d) noise tail.
# This is what "thwoomp" sounds like.
def make_disc_fire():
    dur = 0.65
    n = int(dur * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)

    # (a) Mechanical click at t=0 — very short HP noise transient
    click = np.random.normal(0, 1, n)
    click = highpass(click, 12)
    click_env = np.exp(-t * 220) * (1 - np.exp(-t * 4000))
    sig += click * click_env * 0.45

    # (b) THE THWOOMP — sub-sweep from 180Hz exponentially down to 45Hz
    # phase = 2π ∫ f(t) dt where f(t) = 45 + 135 * exp(-t/0.05)
    f_low, f_extra, tau = 45.0, 135.0, 0.05
    phase = 2 * np.pi * (f_low * t - tau * f_extra * np.exp(-t/tau) + tau * f_extra)
    # Two-stage envelope: fast attack (3ms), exponential body decay
    thwoomp_env = np.exp(-t * 5.5) * (1 - np.exp(-t * 350))
    thwoomp = np.sin(phase) * thwoomp_env
    # Add 2nd harmonic for warmth (octave up at half amplitude)
    thwoomp += 0.35 * np.sin(2 * phase) * thwoomp_env
    sig += thwoomp * 0.85

    # (c) Brassy harmonic ring — short tonal "PWANGGG" component
    # Slight pitch drop on the ring too, gives plasma character
    ring_f = 540 * (1 - 0.15 * (1 - np.exp(-t/0.04)))  # 540Hz dropping to ~460Hz
    ring_phase = 2 * np.pi * np.cumsum(ring_f) / SR
    ring_env = np.exp(-t * 14) * (1 - np.exp(-t * 800))
    ring = (np.sin(ring_phase) + 0.4 * np.sin(2 * ring_phase) +
            0.15 * np.sin(3 * ring_phase)) * ring_env
    sig += ring * 0.18

    # (d) Plasma noise tail — bandpassed broadband fuzz that hangs after
    tail = np.random.normal(0, 1, n)
    tail = bandpass(tail, 30, 6)  # rough 700Hz-3.5kHz band
    tail_env = np.exp(-t * 8) * (1 - np.exp(-t * 300))
    sig += tail * tail_env * 0.12

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

    # Brass resonance: very short 1.2kHz tonal pop (cartridge ring)
    resonance = np.sin(2 * np.pi * 1200 * t) * np.exp(-t * 180) * 0.18
    sig += resonance

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
