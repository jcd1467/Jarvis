import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The Kokoro voice is optional (about 650 MB of dependencies), so it is not in
// package.json. Without it, `kokoro-js` resolves to a stub that fails cleanly
// and the app uses the system or ElevenLabs voice. `npm install kokoro-js`
// turns the real one back on.
const hasKokoro = existsSync('node_modules/kokoro-js/package.json')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: hasKokoro
    ? {}
    : {
        alias: {
          'kokoro-js': fileURLToPath(new URL('./src/lib/kokoro-stub.ts', import.meta.url)),
        },
      },
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: Number(process.env.PORT) || 5173,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
