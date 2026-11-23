Original BomberCraft audio
=========================

The five sixteen-bar music loops and twenty-one sound effects were composed and
synthesized for BomberCraft. The score and instruments are in
`tools/music_score.py`, and the effects are in `tools/sound_effects.py`.

Regenerate from the repository root with:

    python3 tools/generate_audio.py

Requirements: Python 3 and ffmpeg with a Vorbis encoder. Music is stored as
stereo 32 kHz Ogg Vorbis loops. Effects are mono 24 kHz, 16-bit WAV files.

Audio is stored in `html5/src/assets/audio/`. The browser uses
`html5/src/audio.js` for looping, crossfades, sound positioning and volume
controls. The two battle arrangements share a beat grid, so the fuller
arrangement can take over at the one-minute mark.
