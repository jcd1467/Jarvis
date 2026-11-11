// Optional dependency: see src/lib/kokoro-stub.ts. Typed loosely so the app
// compiles whether or not the package is installed; kokoro.ts casts the
// result to its own Kokoro interface anyway.
declare module 'kokoro-js'
