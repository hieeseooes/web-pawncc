# Pawn Studio Web (WASM)

A browser-based IDE and WebAssembly compiler for the Pawn scripting language (SA-MP / open.mp). Compile modular gamemodes, filterscripts, and includes directly in your browser with zero server installation required.

Live Demo: [https://hieeseooes.github.io/web-pawncc/](https://hieeseooes.github.io/web-pawncc/)

## Features

- **Client-Side WebAssembly Compiler**: Compiles scripts locally via `pawncc 3.10.11` compiled to WebAssembly running inside a Web Worker.
- **Full In-Memory Virtual Filesystem (MEMFS)**: Seamless support for `#include` relative directories and modular multi-file architectures.
- **Embedded Includes**: Pre-mounted standard SA-MP/open.mp includes with support for custom zip/folder uploads.
- **CodeMirror 6 Editor**: Fast, accessible code editor with custom dark color scheme, line jumping, and keyboard shortcuts (`Ctrl+S` / `F5` to compile).
- **CodiLime Diagnostics Feed**: Interactive diagnostics pane with filter pills (All, Errors, Warnings, Terminal) and one-click jump directly to the offending line.
- **Multi-File Explorer**: Create, edit, rename, multi-select (`Ctrl+Click`), and delete files with a built-in context menu.
- **Instant AMX Binary Download**: Download compiled `.amx` binaries immediately upon successful compilation.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (or Node.js 18+)

### Development

```bash
# Clone the repository
git clone https://github.com/hieeseooes/web-pawncc.git
cd web-pawncc

# Install dependencies
bun install

# Start local development server
bun run dev
```

Open [http://localhost:5173/](http://localhost:5173/) in your browser.

### Production Build

```bash
bun run build
bun run preview
```

## Architecture

- **Frontend**: Svelte 5 (Runes), Vite, TypeScript, Lucide Icons.
- **Editor**: CodeMirror 6 (`@codemirror/view`, `@codemirror/state`, `@codemirror/lang-cpp`).
- **Compiler Core**: `pawncc 3.10.11` built with Emscripten into WebAssembly (`pawncc.wasm` + `pawncc.js`) with isolated execution in Web Workers.

## License

MIT License. See [LICENSE](LICENSE) for details.
