"""
Render a side-by-side top-down schematic contrasting:
  (A) Rigid Chase-Cam — mouse rotates player body, camera rigidly follows.
  (B) Freelook — camera orbits the player while body keeps facing original heading.

Output: docs/camera_references/diagram_chase_vs_freelook.png
"""
import os
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyArrowPatch, Arc, Circle

OUT = "/home/ubuntu/tribes/docs/camera_references/diagram_chase_vs_freelook.png"
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# Visual constants
BG = "#0d1117"           # Firewolf-style dark background
FG = "#e6edf3"           # light text
ACCENT_BODY = "#ff7043"  # orange for player body / heading
ACCENT_CAM = "#4fc3f7"   # cyan for camera
ACCENT_VEL = "#81c784"   # green for velocity / trajectory
ACCENT_MUTED = "#555c66"
GRID = "#2a313c"

# Figure: two panels side-by-side
fig, axes = plt.subplots(1, 2, figsize=(16, 8), facecolor=BG)
fig.suptitle("Tribes 2 Third-Person Camera: Rigid Chase vs. Freelook (top-down view)",
             color=FG, fontsize=17, fontweight="bold", y=0.97)


def setup_ax(ax, title):
    ax.set_facecolor(BG)
    ax.set_xlim(-5, 5)
    ax.set_ylim(-5, 5)
    ax.set_aspect("equal")
    ax.set_title(title, color=FG, fontsize=14, fontweight="bold", pad=12)
    # light grid
    for v in np.arange(-5, 6, 1):
        ax.axhline(v, color=GRID, lw=0.4, zorder=0)
        ax.axvline(v, color=GRID, lw=0.4, zorder=0)
    ax.tick_params(colors=ACCENT_MUTED, labelsize=8)
    for spine in ax.spines.values():
        spine.set_color(ACCENT_MUTED)


def draw_player(ax, x, y, heading_deg, color=ACCENT_BODY, alpha=1.0, label=None):
    """Draw a player marker: a circle with a short arrow showing body-facing."""
    ax.add_patch(Circle((x, y), 0.28, facecolor=color, edgecolor=FG,
                        lw=1.2, alpha=alpha, zorder=4))
    h = np.deg2rad(heading_deg)
    ax.annotate("", xy=(x + 0.75 * np.cos(h), y + 0.75 * np.sin(h)),
                xytext=(x, y),
                arrowprops=dict(arrowstyle="->", color=color, lw=2.2, alpha=alpha),
                zorder=5)
    if label:
        ax.text(x, y - 0.55, label, color=color, fontsize=9, ha="center",
                alpha=alpha, zorder=5)


def draw_camera(ax, px, py, cam_angle_deg, distance=1.5, color=ACCENT_CAM,
                alpha=1.0, label=None, show_frustum=True):
    """Draw a camera marker at `distance` behind the player along cam_angle_deg.
    cam_angle_deg is the direction the camera is LOOKING (toward the player)."""
    # camera is positioned opposite the looking direction from player
    opposite = np.deg2rad(cam_angle_deg + 180)
    cx = px + distance * np.cos(opposite)
    cy = py + distance * np.sin(opposite)
    # Camera body: small rectangle
    ax.add_patch(Circle((cx, cy), 0.18, facecolor=color, edgecolor=FG,
                        lw=1.0, alpha=alpha, zorder=4))
    # Line from camera to player (look vector)
    ax.plot([cx, px], [cy, py], color=color, lw=1.4, alpha=alpha * 0.8,
            linestyle=":", zorder=3)
    # Frustum (optional) — a small triangle showing FOV
    if show_frustum:
        look = np.deg2rad(cam_angle_deg)
        fov = np.deg2rad(45)
        reach = 2.5
        p1 = (cx + reach * np.cos(look - fov), cy + reach * np.sin(look - fov))
        p2 = (cx + reach * np.cos(look + fov), cy + reach * np.sin(look + fov))
        frustum = plt.Polygon([(cx, cy), p1, p2], closed=True,
                              facecolor=color, alpha=alpha * 0.10,
                              edgecolor=color, linestyle="--", lw=0.8, zorder=2)
        ax.add_patch(frustum)
    if label:
        ax.text(cx, cy + 0.40, label, color=color, fontsize=9, ha="center",
                alpha=alpha, zorder=5)
    return cx, cy


def curved_arrow(ax, center, radius, start_deg, end_deg, color, label=None,
                 label_r=None, label_offset=(0, 0)):
    """Draw a curved arc arrow indicating rotation."""
    arc = Arc(center, 2 * radius, 2 * radius, angle=0,
              theta1=start_deg, theta2=end_deg, color=color, lw=2.2, zorder=3)
    ax.add_patch(arc)
    # arrowhead at end_deg
    end_rad = np.deg2rad(end_deg)
    tip = (center[0] + radius * np.cos(end_rad),
           center[1] + radius * np.sin(end_rad))
    # tangent direction
    tang = (-np.sin(end_rad), np.cos(end_rad))
    head = (tip[0] + 0.18 * tang[0], tip[1] + 0.18 * tang[1])
    ax.annotate("", xy=head, xytext=tip,
                arrowprops=dict(arrowstyle="->", color=color, lw=2.2),
                zorder=4)
    if label:
        mid_rad = np.deg2rad((start_deg + end_deg) / 2)
        lr = label_r if label_r is not None else radius + 0.35
        lx = center[0] + lr * np.cos(mid_rad) + label_offset[0]
        ly = center[1] + lr * np.sin(mid_rad) + label_offset[1]
        ax.text(lx, ly, label, color=color, fontsize=9, ha="center", va="center")


# =========================================================================
# LEFT PANEL: Rigid Chase
# =========================================================================
axL = axes[0]
setup_ax(axL, "A. Rigid Chase-Cam  (default mode)")

# BEFORE state (faded): player faces north, camera behind (south of player)
draw_player(axL, 0, 0, 90, color=ACCENT_BODY, alpha=0.35, label="body (t₀)")
draw_camera(axL, 0, 0, 90, distance=1.5, color=ACCENT_CAM,
            alpha=0.35, label="camera (t₀)")

# Velocity arrow (north)
axL.annotate("", xy=(0, 2.8), xytext=(0, 1.2),
             arrowprops=dict(arrowstyle="->", color=ACCENT_VEL, lw=2),
             zorder=3)
axL.text(0.15, 2.2, "velocity\n(forward)", color=ACCENT_VEL, fontsize=9, va="center")

# AFTER state (solid): mouse moves right → body rotates ~45° CW (heading 45°)
# Camera rotates with the body (still directly behind)
draw_player(axL, 0, 0, 45, color=ACCENT_BODY, alpha=1.0, label="body (t₁)")
draw_camera(axL, 0, 0, 45, distance=1.5, color=ACCENT_CAM,
            alpha=1.0, label="camera (t₁)")

# Rotation arc — body rotation (90° -> 45° CW, a 45° sweep)
curved_arrow(axL, (0, 0), 1.05, 45, 90, ACCENT_BODY,
             label="body\nyaw −45°", label_r=1.50, label_offset=(0.1, 0.25))
# Reverse the arrow direction manually: we want the tip to point at 45° (end position)
# Done via start_deg > end_deg being swapped above. Re-use curved_arrow is fine.

# Rotation arc — camera rotation (camera is 180° opposite body, so it swings
# from 270° (south) to 225° (SW), exactly 45° — matches body rotation)
curved_arrow(axL, (0, 0), 1.75, 225, 270, ACCENT_CAM,
             label="camera rotates\nwith body", label_r=2.30, label_offset=(-0.3, -0.1))

# NEW velocity direction — also rotates, because body faces new direction
# and player moves where body faces
vnx, vny = 2.0 * np.cos(np.deg2rad(45)), 2.0 * np.sin(np.deg2rad(45))
axL.annotate("", xy=(vnx, vny), xytext=(0.4 * np.cos(np.deg2rad(45)),
                                         0.4 * np.sin(np.deg2rad(45))),
             arrowprops=dict(arrowstyle="->", color=ACCENT_VEL, lw=2),
             zorder=3)
axL.text(vnx + 0.15, vny + 0.15, "new velocity\n(trajectory changes)",
         color=ACCENT_VEL, fontsize=9)

# Mouse input label
axL.text(-4.7, 4.5, "mouse right →",
         color=FG, fontsize=10, fontweight="bold")
axL.text(-4.7, 4.15, "body yaws right",
         color=ACCENT_BODY, fontsize=9)
axL.text(-4.7, 3.85, "camera follows rigidly",
         color=ACCENT_CAM, fontsize=9)
axL.text(-4.7, 3.55, "trajectory also turns",
         color=ACCENT_VEL, fontsize=9)

# Summary box
axL.text(0, -4.4,
         "Mouse-look rotates body + camera together.\nWhere you look is where you steer.",
         color=FG, fontsize=10, ha="center",
         bbox=dict(boxstyle="round,pad=0.4", facecolor="#1f2a36",
                   edgecolor=ACCENT_MUTED))


# =========================================================================
# RIGHT PANEL: Freelook
# =========================================================================
axR = axes[1]
setup_ax(axR, "B. Freelook  (held key, e.g., Left Alt)")

# BEFORE state (faded): player facing north, camera behind
draw_player(axR, 0, 0, 90, color=ACCENT_BODY, alpha=0.35, label="body (t₀)")
draw_camera(axR, 0, 0, 90, distance=1.5, color=ACCENT_CAM,
            alpha=0.35, label="camera (t₀)")

# AFTER: body STAYS facing north (unchanged). Only camera orbits.
# Camera's looking direction rotates — say to ~45° (mouse right by 45°)
draw_player(axR, 0, 0, 90, color=ACCENT_BODY, alpha=1.0, label="body (t₁)\nunchanged")
draw_camera(axR, 0, 0, 45, distance=1.5, color=ACCENT_CAM,
            alpha=1.0, label="camera (t₁)")

# Rotation arc — camera orbits around player (45° sweep: south -> southwest)
curved_arrow(axR, (0, 0), 1.75, 225, 270, ACCENT_CAM,
             label="camera orbits\naround player",
             label_r=2.35, label_offset=(-0.3, -0.2))

# Velocity: UNCHANGED, still pointing north
axR.annotate("", xy=(0, 2.8), xytext=(0, 1.2),
             arrowprops=dict(arrowstyle="->", color=ACCENT_VEL, lw=2),
             zorder=3)
axR.text(0.15, 2.2, "velocity\n(unchanged —\nstill north)",
         color=ACCENT_VEL, fontsize=9, va="center")

# Mouse input label
axR.text(-4.7, 4.5, "mouse right →",
         color=FG, fontsize=10, fontweight="bold")
axR.text(-4.7, 4.15, "body stays facing forward",
         color=ACCENT_BODY, fontsize=9)
axR.text(-4.7, 3.85, "camera orbits the player",
         color=ACCENT_CAM, fontsize=9)
axR.text(-4.7, 3.55, "trajectory unchanged",
         color=ACCENT_VEL, fontsize=9)

# Summary box
axR.text(0, -4.4,
         "Mouse-look rotates only the camera.\n"
         "Useful for looking behind while skiing forward.",
         color=FG, fontsize=10, ha="center",
         bbox=dict(boxstyle="round,pad=0.4", facecolor="#1f2a36",
                   edgecolor=ACCENT_MUTED))

# Shared legend in the figure
body_patch = mpatches.Patch(color=ACCENT_BODY, label="Player body (orange arrow = facing)")
cam_patch = mpatches.Patch(color=ACCENT_CAM, label="Camera (cyan — dotted line = look vector)")
vel_patch = mpatches.Patch(color=ACCENT_VEL, label="Velocity / trajectory direction")
fig.legend(handles=[body_patch, cam_patch, vel_patch],
           loc="lower center", ncol=3, frameon=False,
           labelcolor=FG, fontsize=10, bbox_to_anchor=(0.5, 0.01))

plt.tight_layout(rect=[0, 0.05, 1, 0.94])
plt.savefig(OUT, dpi=150, facecolor=BG, bbox_inches="tight")
print(f"Wrote {OUT}")
