/**
 * Stands in for `kokoro-js` when it is not installed.
 *
 * The in-browser neural voice is optional and its dependencies weigh about
 * 650 MB on disk, so it is no longer installed by default. vite.config.ts
 * aliases `kokoro-js` here when the package is absent; load() in kokoro.ts
 * catches the throw and falls back to the system or ElevenLabs voice.
 * `npm install kokoro-js` brings the real engine back.
 */
export const KokoroTTS = {
  from_pretrained(): Promise<never> {
    return Promise.reject(
      new Error('kokoro-js is not installed — run `npm install kokoro-js` to use the Kokoro voice'),
    )
  },
}
