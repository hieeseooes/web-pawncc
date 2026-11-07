// pawn.worker.ts - Web Worker for executing the Pawn compiler in WebAssembly
// @ts-ignore
import PawnCompiler from './pawncc.js';
import { unzipSync } from 'fflate';

let standardIncludes: Record<string, string> = {};
let isInitialized = false;
let baseAssetUrl = '';

function resolveAssetUrl(relPath: string): string {
  if (baseAssetUrl) {
    return new URL(relPath, baseAssetUrl).href;
  }
  try {
    return new URL(`../${relPath}`, self.location.href).href;
  } catch (_) {
    return `/${relPath}`;
  }
}

// Load standard includes bundled in public/includes.json
async function initIncludes(baseUrl?: string) {
  if (baseUrl) baseAssetUrl = baseUrl;
  if (isInitialized && Object.keys(standardIncludes).length > 0) return;
  try {
    const targetUrl = resolveAssetUrl('includes.json');
    const res = await fetch(targetUrl);
    if (res.ok) {
      standardIncludes = await res.json();
    }
  } catch (err) {
    console.warn('Failed to load standard includes:', err);
  }
  isInitialized = true;
}

// Helper: Ensure directory hierarchy exists in Emscripten MEMFS
function ensureDir(FS: any, fullPath: string) {
  const parts = fullPath.split('/').filter(Boolean);
  let current = '';
  // exclude the last element (filename)
  for (let i = 0; i < parts.length - 1; i++) {
    current += '/' + parts[i];
    try {
      if (!FS.analyzePath(current).exists) {
        FS.mkdir(current);
      }
    } catch (_) {}
  }
}

// Helper: Normalize Windows backslashes in #include statements to forward slashes
function normalizePawnIncludes(code: string): string {
  return code.replace(/#include\s+([<"])([^>"]+)([>"])/g, (_, open, incPath, close) => {
    return `#include ${open}${incPath.replace(/\\/g, '/')}${close}`;
  });
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, baseUrl } = e.data;
  if (baseUrl) baseAssetUrl = baseUrl;

  if (type === 'init') {
    await initIncludes(baseUrl);
    self.postMessage({ type: 'ready', includeCount: Object.keys(standardIncludes).length });
    return;
  }

  if (type === 'compile') {
    await initIncludes(baseUrl);
    const { 
      files = {}, 
      entryFile = 'main.pwn', 
      customIncludes = {}, 
      zipIncludes = null,
      args = [] 
    } = payload;

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    try {
      // @ts-ignore
      const compilerModule = await PawnCompiler({
        locateFile: (path: string) => resolveAssetUrl(path),
        print: (text: string) => {
          stdoutLines.push(text);
        },
        printErr: (text: string) => {
          stderrLines.push(text);
        },
        noInitialRun: true
      });

      const FS = compilerModule.FS;

      // 1. Setup base virtual directories
      try { FS.mkdir('/include'); } catch (_) {}
      try { FS.mkdir('/workspace'); } catch (_) {}

      // 2. Write standard includes
      for (const [incName, content] of Object.entries(standardIncludes)) {
        const fullIncPath = '/include/' + incName;
        ensureDir(FS, fullIncPath);
        try {
          FS.writeFile(fullIncPath, content as string);
        } catch (_) {}
      }

      // 3. Unpack any zip include bundles (e.g. YSI zip) if provided
      if (zipIncludes) {
        try {
          const unzipped = unzipSync(new Uint8Array(zipIncludes));
          for (const [relPath, fileData] of Object.entries(unzipped)) {
            if (relPath.endsWith('/')) continue; // directory entry
            const targetPath = '/include/' + relPath.replace(/\\/g, '/');
            ensureDir(FS, targetPath);
            FS.writeFile(targetPath, fileData);
          }
        } catch (zErr) {
          stderrLines.push(`[ZIP Error] Failed to extract include zip: ${zErr}`);
        }
      }

      // 4. Write user custom includes (e.g. dropped custom includes)
      for (const [relPath, content] of Object.entries(customIncludes)) {
        const normalizedRel = (relPath as string).replace(/\\/g, '/');
        const targetPath = '/include/' + normalizedRel;
        ensureDir(FS, targetPath);
        try {
          FS.writeFile(targetPath, normalizePawnIncludes(content as string));
        } catch (_) {}
      }

      // 5. Write all project workspace files (modular gamemode structure)
      for (const [relPath, content] of Object.entries(files)) {
        const normalizedRel = (relPath as string).replace(/\\/g, '/');
        const targetPath = '/workspace/' + normalizedRel;
        ensureDir(FS, targetPath);
        try {
          FS.writeFile(targetPath, normalizePawnIncludes(content as string));
        } catch (_) {}
      }

      // 6. Build entry file paths and output names
      const normalizedEntry = entryFile.replace(/\\/g, '/');
      const sourcePath = '/workspace/' + normalizedEntry;
      const baseName = normalizedEntry.replace(/\.[^/.]+$/, "");
      const outPath = '/workspace/' + baseName + '.amx';

      // Find the folder where the entry file resides (e.g. /workspace/gamemodes)
      const entryDirParts = ('/workspace/' + normalizedEntry).split('/');
      entryDirParts.pop();
      const entryDir = entryDirParts.join('/');

      // 7. Assemble compiler arguments
      const defaultArgs = [
        sourcePath,
        `-o${outPath}`,
        `-i${entryDir}`,       // current folder of the entry file
        '-i/workspace',        // project root folder
        '-i/include',          // standard & custom includes
        '-d3',
        '-Z+'
      ];

      const cliArgs = [...defaultArgs, ...(args || [])];

      // 8. Execute compiler
      let exitCode = 0;
      try {
        exitCode = compilerModule.callMain(cliArgs);
      } catch (runErr: any) {
        if (runErr && typeof runErr.status !== 'undefined') {
          exitCode = runErr.status;
        } else {
          stderrLines.push(String(runErr));
          exitCode = -1;
        }
      }

      // 9. Retrieve compiled .amx binary
      let amxBytes: Uint8Array | null = null;
      let compiledSuccess = false;

      try {
        if (FS.analyzePath(outPath).exists) {
          amxBytes = FS.readFile(outPath);
          compiledSuccess = true;
        }
      } catch (_) {}

      self.postMessage({
        type: 'compile_result',
        success: compiledSuccess && exitCode === 0,
        exitCode,
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
        amx: amxBytes,
        outputFileName: baseName.split('/').pop() + '.amx'
      });

    } catch (err: any) {
      self.postMessage({
        type: 'compile_result',
        success: false,
        exitCode: -1,
        stdout: stdoutLines.join('\n'),
        stderr: (stderrLines.join('\n') + '\nWorker Error: ' + (err?.message || err)).trim(),
        amx: null
      });
    }
  }
};
