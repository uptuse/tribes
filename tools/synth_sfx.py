"""
R32.12 — Procedural SFX synthesis for Tribes Raindance audio overhaul.
Outputs 16-bit mono WAV files at 44.1kHz suitable for direct decode by WebAudio.

Why Python and not the music tool:
  - Short SFX need precise control over envelope/spectrum, not a creative AI.
  - 50-line procedural recipes give crisp, repeatable results that beat
    the existing 1-line procedural envelopes baked into AE.init() in
    index.html (those were too short / too flat).
  - WAV files are tiny (well under 100KB each) so payload stays small.

Generates:
  lightning_crack.wav  — sharp ionized crack + roll-off
  ski_rush.wav         — wide-band frictionless slide rush (LOOP)
  disc_fire.wav        — punchy bass thump + plasma whoosh (replaces buf[0])
  hard_landing.wav     — meaty body-hit thud (replaces buf[9] for big falls)
"""
import numpy as np
import wave
import struct
import os

SR = 44100
OUT_DIR = "/home/ubuntu/tribes/assets/audio/sfx"
os.makedirs(OUT_DIR, exist_ok=True)

def write_wav(path, samples, sr=SR):
    """Write float32 samples in [-1,1] to 16-bit PCM mono WAV."""
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    print(f"  wrote {path}  ({len(samples)/sr:.2f}s, {os.path.getsize(path)/1024:.1f} KB)")


# ---------------------------------------------------------------
# 1. LIGHTNING CRACK — sharp tearing crack + crackle tail
# ---------------------------------------------------------------
# Real lightning cracks are: ionized-air rip (broadband 2-8kHz transient,
# very fast attack ~5ms), followed by ~0.5-1.5s of crackling thunder roll.
# We layer: (a) a short white-noise burst high-passed for the rip,
# (b) a low rumble for the body, (c) a few random "branch crackles".
def make_lightning_crack():
    dur = 1.6
    n = int(dur * SR)
    t = np.arange(n) / SR
    # (a) Initial rip — high-passed white noise, very fast attack, fast decay
    rip = np.random.normal(0, 1, n)
    # crude one-pole high-pass: y[n] = x[n] - 0.97*x[n-1]
    rip_hp = np.zeros(n)
    prev = 0.0
    for i in range(n):
        rip_hp[i] = rip[i] - 0.97 * prev
        prev = rip[i]
    rip_env = np.exp(-t * 18.0) * (1 - np.exp(-t * 400.0))  # 2.5ms attack, ~55ms tail
    rip_sig = rip_hp * rip_env * 0.7
    # (b) Body rumble — low-passed noise, slower envelope
    rumble = np.random.normal(0, 1, n)
    # crude lowpass: 5-tap moving average twice (cuts above ~3kHz)
    rumble = np.convolve(rumble, np.ones(8)/8, mode='same')
    rumble = np.convolve(rumble, np.ones(8)/8, mode='same')
    rumble_env = np.exp(-t * 2.5) * (1 - np.exp(-t * 30.0))
    rumble_sig = rumble * rumble_env * 0.55
    # (c) Random branch crackles — 6-10 short pops scattered through 0.05-0.8s
    crackles = np.zeros(n)
    rng = np.random.default_rng(42)
    for _ in range(rng.integers(8, 14)):
        pop_t = rng.uniform(0.05, 0.85)
        pop_n = int(pop_t * SR)
        pop_dur = int(0.025 * SR)
        if pop_n + pop_dur >= n: continue
        pop_env = np.exp(-np.arange(pop_dur) / pop_dur * 12)
        pop_sig = np.random.normal(0, 1, pop_dur) * pop_env * rng.uniform(0.3, 0.7)
        crackles[pop_n:pop_n+pop_dur] += pop_sig
    sig = rip_sig + rumble_sig + crackles
    # Final fade-out to avoid click
    fade_n = int(0.05 * SR)
    sig[-fade_n:] *= np.linspace(1, 0, fade_n)
    # Normalize peak to ~0.92
    sig = sig / np.max(np.abs(sig)) * 0.92
    write_wav(f"{OUT_DIR}/lightning_crack.wav", sig)


# ---------------------------------------------------------------
# 2. SKI RUSH — looping high-speed frictionless slide
# ---------------------------------------------------------------
# Distinct from jetpack (which is hot-air whoosh, mid-low bandwidth).
# Ski sound = wide-band air rush + low-mid grit (snow/rock skid),
# with subtle pitch wobble for organic feel. LOOPS cleanly.
def make_ski_rush():
    dur = 1.5  # short loop, AE.startSki sets src.loop=true
    n = int(dur * SR)
    t = np.arange(n) / SR
    # Wide-band noise base
    base = np.random.normal(0, 1, n)
    # Bandpass-ish: subtract slow-LP and slow-HP to leave 200Hz - 6kHz
    lp = np.convolve(base, np.ones(6)/6, mode='same')  # cuts ~7kHz+
    hp_part = base - np.convolve(base, np.ones(120)/120, mode='same')  # removes <300Hz
    body = lp * 0.4 + hp_part * 0.55
    # Add a subtle low rumble (gritty terrain contact)
    rumble = np.sin(2 * np.pi * 80 * t + np.sin(2*np.pi*0.7*t)*0.4) * 0.08
    rumble += np.random.normal(0, 1, n) * 0.04 * np.exp(-((t - 0.75)**2) / 0.5)
    # Slow amplitude wobble (organic terrain variation)
    wobble = 0.85 + 0.15 * np.sin(2 * np.pi * 1.3 * t + 0.5 * np.sin(2*np.pi*0.4*t))
    sig = (body + rumble) * wobble
    # CRITICAL: make loop seamless — crossfade last 50ms with first 50ms
    fade_n = int(0.05 * SR)
    fade = np.linspace(0, 1, fade_n)
    sig[:fade_n] = sig[:fade_n] * fade + sig[-fade_n:] * (1 - fade)
    # Drop the now-redundant tail by zero-blending
    sig[-fade_n:] = sig[-fade_n:] * fade[::-1] + sig[:fade_n] * (1 - fade[::-1])
    sig = sig / np.max(np.abs(sig)) * 0.55  # quieter than jet, leaves headroom
    write_wav(f"{OUT_DIR}/ski_rush.wav", sig)


# ---------------------------------------------------------------
# 3. DISC FIRE — punchy bass thump + plasma whoosh
# ---------------------------------------------------------------
# Tribes spinfusor/disc launcher: deep "whomp" with a metallic top.
# Layers: (a) sub-sine swept from 90 -> 35 Hz over 80ms, (b) noise burst
# bandpassed 800-3kHz for the plasma sizzle, (c) very short metallic ping
# at the front for the launcher mechanism.
def make_disc_fire():
    dur = 0.45
    n = int(dur * SR)
    t = np.arange(n) / SR
    # (a) Sub-sweep: phase = 2π ∫ f(τ) dτ; f(t) = 35 + 55 * exp(-t/0.04)
    f0 = 35.0
    f_extra = 55.0
    # Integral of f0 + f_extra * exp(-t/tau) is f0*t - tau*f_extra*exp(-t/tau) + const
    tau = 0.04
    phase = 2 * np.pi * (f0 * t - tau * f_extra * np.exp(-t / tau) + tau * f_extra)
    sub_env = np.exp(-t * 7.0) * (1 - np.exp(-t * 200.0))
    sub = np.sin(phase) * sub_env * 0.85
    # (b) Plasma sizzle — bandpass white noise
    noise = np.random.normal(0, 1, n)
    # cheap bandpass: HP-LP
    lp_noise = np.convolve(noise, np.ones(10)/10, mode='same')
    bp = noise - lp_noise * 0.7  # rough HP
    bp = np.convolve(bp, np.ones(4)/4, mode='same')  # rough LP
    sizzle_env = np.exp(-t * 11.0) * (1 - np.exp(-t * 350.0))
    sizzle = bp * sizzle_env * 0.4
    # (c) Front metallic ping — short tonal burst
    ping_dur = int(0.025 * SR)
    ping_env = np.exp(-np.arange(ping_dur) / ping_dur * 14)
    ping_sig = (np.sin(2*np.pi*1850*np.arange(ping_dur)/SR) +
                np.sin(2*np.pi*2400*np.arange(ping_dur)/SR)*0.5) * ping_env * 0.25
    ping = np.zeros(n)
    ping[:ping_dur] = ping_sig
    sig = sub + sizzle + ping
    # Final fade-out
    fade_n = int(0.04 * SR)
    sig[-fade_n:] *= np.linspace(1, 0, fade_n)
    sig = sig / np.max(np.abs(sig)) * 0.95
    write_wav(f"{OUT_DIR}/disc_fire.wav", sig)


# ---------------------------------------------------------------
# 4. HARD LANDING — meaty body-impact thud (for falls > ~12 m/s)
# ---------------------------------------------------------------
# Two-layer impact: (a) low body thud sub-sine ~50 Hz, (b) high crunch
# noise (gear clatter/armor flex). Replaces buf[9] for hard impacts only —
# regular footsteps stay procedural.
def make_hard_landing():
    dur = 0.35
    n = int(dur * SR)
    t = np.arange(n) / SR
    # (a) Body thud
    body = np.sin(2 * np.pi * 50 * t) * np.exp(-t * 9.0) * (1 - np.exp(-t * 250.0))
    body += np.sin(2 * np.pi * 75 * t) * np.exp(-t * 12.0) * 0.4
    body *= 0.85
    # (b) Gear/armor crunch — mid-frequency noise burst
    crunch = np.random.normal(0, 1, n)
    crunch = np.convolve(crunch, np.ones(5)/5, mode='same')  # tame top end
    crunch -= np.convolve(crunch, np.ones(40)/40, mode='same')  # remove low end
    crunch_env = np.exp(-t * 16.0) * (1 - np.exp(-t * 300.0))
    crunch *= crunch_env * 0.45
    sig = body + crunch
    # Tail fade
    fade_n = int(0.03 * SR)
    sig[-fade_n:] *= np.linspace(1, 0, fade_n)
    sig = sig / np.max(np.abs(sig)) * 0.95
    write_wav(f"{OUT_DIR}/hard_landing.wav", sig)


if __name__ == "__main__":
    print("Synthesizing R32.12 SFX assets...")
    make_lightning_crack()
    make_ski_rush()
    make_disc_fire()
    make_hard_landing()
    print("Done.")


# ---------------------------------------------------------------
# 5. DISC IMPACT — meaty explosion thump on hit (slot 4)
# ---------------------------------------------------------------
# The original procedural slot 4 was 0.15s of pure white-noise — sounded
# like static when you hit something. Real disc impacts in Tribes are a
# big subby BOOM with a noise crunch on top.
def make_disc_impact():
    dur = 0.65
    n = int(dur * SR)
    t = np.arange(n) / SR
    # Sub thump: 60Hz → 30Hz exponential drop, fast attack
    f0 = 30.0; f_extra = 70.0; tau = 0.05
    phase = 2 * np.pi * (f0 * t - tau * f_extra * np.exp(-t / tau) + tau * f_extra)
    sub_env = np.exp(-t * 4.5) * (1 - np.exp(-t * 250.0))
    sub = np.sin(phase) * sub_env * 0.85
    # Mid crunch: bandpassed noise (debris/shrapnel)
    crunch = np.random.normal(0, 1, n)
    crunch_lp = np.convolve(crunch, np.ones(8)/8, mode='same')
    crunch_hp = crunch - np.convolve(crunch, np.ones(60)/60, mode='same')
    crunch_bp = (crunch_lp * 0.4 + crunch_hp * 0.6)
    crunch_env = np.exp(-t * 7.0) * (1 - np.exp(-t * 300.0))
    crunch_sig = crunch_bp * crunch_env * 0.55
    # High sizzle tail (smoke/embers)
    sizzle = np.random.normal(0, 1, n)
    sizzle = sizzle - np.convolve(sizzle, np.ones(20)/20, mode='same')
    sizzle_env = np.exp(-t * 2.5) * (1 - np.exp(-t * 150.0))
    sizzle_sig = sizzle * sizzle_env * 0.20
    sig = sub + crunch_sig + sizzle_sig
    fade_n = int(0.05 * SR)
    sig[-fade_n:] *= np.linspace(1, 0, fade_n)
    sig = sig / np.max(np.abs(sig)) * 0.95
    write_wav(f"{OUT_DIR}/disc_impact.wav", sig)


# ---------------------------------------------------------------
# 6. CHAINGUN — punchy tac-pop (slot 1)
# ---------------------------------------------------------------
# Original was 0.04s of decayed white noise (no body). Real chaingun
# rounds need a sharp pop with bass body so they read at any distance.
def make_chaingun():
    dur = 0.10
    n = int(dur * SR)
    t = np.arange(n) / SR
    # Crack: high-passed noise burst
    crack = np.random.normal(0, 1, n)
    crack = crack - np.convolve(crack, np.ones(15)/15, mode='same')
    crack_env = np.exp(-t * 50.0) * (1 - np.exp(-t * 1000.0))
    crack_sig = crack * crack_env * 0.7
    # Body: short sub-blip ~80Hz
    body = np.sin(2 * np.pi * 90 * t) * np.exp(-t * 35) * 0.5
    sig = crack_sig + body
    sig = sig / np.max(np.abs(sig)) * 0.92
    write_wav(f"{OUT_DIR}/chaingun.wav", sig)


# Re-run all if invoked directly with --add flag
if __name__ == "__main__" and len(__import__('sys').argv) > 1 and __import__('sys').argv[1] == '--add':
    print("Adding R32.12.3 SFX...")
    make_disc_impact()
    make_chaingun()
    print("Done.")
