/**
 * Playtest — Shift+P from any edit mode.
 * Teleports player to cursor and enters Play.
 * Extracted from shell.js for cleanliness.
 */
export const Playtest = {
  fromCursor() {
    const cursor = window.__editorCursorWorld;
    if (cursor && window.Module?._teleportPlayer) {
      Module._teleportPlayer(cursor.x, cursor.y + 2, cursor.z);
    }
    window.__shell?.switchMode('play');
  },
};
