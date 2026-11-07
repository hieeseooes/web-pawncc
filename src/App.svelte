<script lang="ts">
  import { onMount } from 'svelte';
  import { basicSetup, EditorView } from 'codemirror';
  import { cpp } from '@codemirror/lang-cpp';
  import { oneDark } from '@codemirror/theme-one-dark';
  import { EditorState } from '@codemirror/state';
  import {
    Play,
    Download,
    FolderOpen,
    FileCode,
    FileText,
    FilePlus,
    FileUp,
    Trash2,
    Settings,
    Terminal,
    AlertTriangle,
    AlertCircle,
    CheckCircle2,
    Package,
    Cpu,
    FolderTree,
    Layers,
    FileCheck,
    SlidersHorizontal,
    X,
    HardDrive,
    Pencil,
    Copy,
    Target,
    Search
  } from '@lucide/svelte';

  // Preset Project Templates
  const TEMPLATES: Record<string, { entry: string; files: Record<string, string> }> = {
    'Modular Gamemode': {
      entry: 'gamemodes/main.pwn',
      files: {
        'gamemodes/main.pwn': `#define FILTERSCRIPT
#include <a_samp>

// Relative modular includes with subdirectories & Windows-style backslash test
#include "api\\admin\\blabla.inc"
#include "modules/vehicle.pwn"

#pragma dynamic 65536

public OnFilterScriptInit()
{
    print("\\n--------------------------------------");
    print("  Modular Gamemode Loaded Successfully! ");
    print("--------------------------------------\\n");
    InitAdminSystem();
    InitVehicleSystem();
    return 1;
}

main() {}
`,
        'gamemodes/api/admin/blabla.inc': `// api/admin/blabla.inc - Modular Admin System

stock InitAdminSystem()
{
    print("[Module] Admin System v1.0 initialized.");
}

stock CheckPlayerAdminLevel(playerid)
{
    // Dummy admin check
    return (playerid == 0) ? 5 : 0;
}
`,
        'gamemodes/modules/vehicle.pwn': `// modules/vehicle.pwn - Modular Vehicle Subsystem

stock InitVehicleSystem()
{
    print("[Module] Vehicle Subsystem initialized.");
}
`
      }
    },
    'Simple Gamemode': {
      entry: 'gamemode.pwn',
      files: {
        'gamemode.pwn': `#define FILTERSCRIPT
#include <a_samp>

#pragma dynamic 32768

public OnFilterScriptInit()
{
    print("SA-MP Gamemode initialized in WebAssembly!");
    return 1;
}

public OnPlayerConnect(playerid)
{
    SendClientMessage(playerid, 0x00FF00AA, "Welcome to the server!");
    return 1;
}

main() {}
`
      }
    },
    'Hello World (Console)': {
      entry: 'hello.pwn',
      files: {
        'hello.pwn': `#include <core>
#include <console>

main()
{
    print("====================================");
    print(" Hello from Pawn Compiler in WASM! ");
    print("====================================");
}
`
      }
    }
  };

  let editorContainer: HTMLDivElement;
  let editorView: EditorView | null = null;
  let folderInput = $state<HTMLInputElement>();
  let includeFolderInput = $state<HTMLInputElement>();
  let singlePwnInput = $state<HTMLInputElement>();
  let isOutputOpen = $state(true);

  let worker: Worker | null = null;
  let isWorkerReady = $state(false);
  let isCompiling = $state(false);
  let compileStatus = $state<'idle' | 'success' | 'error'>('idle');
  let includeCount = $state(0);

  let currentTemplate = $state('Modular Gamemode');
  // Raw file content storage (plain JS object to prevent Svelte 5 reactivity cycle per keystroke)
  let fileContents: Record<string, string> = { ...TEMPLATES['Modular Gamemode'].files };
  // Reactive file list for UI sidebar
  let fileList = $state<string[]>(Object.keys(TEMPLATES['Modular Gamemode'].files));
  let activeFileName = $state<string>(TEMPLATES['Modular Gamemode'].entry);
  let entryFileName = $state<string>(TEMPLATES['Modular Gamemode'].entry);
  // Multi-selection state via Ctrl + Click
  let selectedFiles = $state<string[]>([TEMPLATES['Modular Gamemode'].entry]);
  let sortedFileList = $derived([...fileList].sort());
  let breadcrumbs = $derived(activeFileName.split('/').filter(Boolean));

  // Activity Rail Tab: 'explorer' | 'includes' | 'settings'
  let activityTab = $state<'explorer' | 'includes' | 'settings'>('explorer');

  // Diagnostics & Output View State
  let activeOutputView = $state<'issues' | 'raw'>('issues');
  let diagnosticsFilter = $state<'all' | 'errors' | 'warnings'>('all');
  let includeSearch = $state('');
  let includesSubTab = $state<'standard' | 'custom'>('standard');

  let customIncludes = $state<Record<string, string>>({});
  let compilerFlags = $state('-d3 -Z+ -;+ -S65536');
  let consoleOutput = $state<string>('Initializing WebAssembly compiler...\n');
  let diagnostics = $state<{ type: 'error' | 'warning'; file: string; line: number; code: string; message: string }[]>([]);
  let amxBlobUrl = $state<string | null>(null);
  let amxSizeFormatted = $state<string | null>(null);
  let downloadedFileName = $state<string>('gamemode.amx');
  let availableIncludes = $state<string[]>([]);
  let showFlagsModal = $state(false);

  // Derived counts for CodiLime badges
  let errorCount = $derived(diagnostics.filter(d => d.type === 'error').length);
  let warningCount = $derived(diagnostics.filter(d => d.type === 'warning').length);
  let filteredDiagnostics = $derived(
    diagnosticsFilter === 'all'
      ? diagnostics
      : diagnostics.filter(d => d.type === (diagnosticsFilter === 'errors' ? 'error' : 'warning'))
  );
  let filteredStandardIncludes = $derived(
    includeSearch.trim()
      ? availableIncludes.filter(inc => inc.toLowerCase().includes(includeSearch.toLowerCase()))
      : availableIncludes
  );
  let filteredCustomIncludes = $derived(
    includeSearch.trim()
      ? Object.keys(customIncludes).filter(inc => inc.toLowerCase().includes(includeSearch.toLowerCase()))
      : Object.keys(customIncludes)
  );

  // Custom Context Menu State
  let contextMenu = $state<{
    visible: boolean;
    x: number;
    y: number;
    target: string;
  }>({ visible: false, x: 0, y: 0, target: '' });

  function onContextMenu(e: MouseEvent, path: string) {
    e.preventDefault();
    if (!selectedFiles.includes(path)) {
      selectedFiles = [path];
      switchFile(path);
    }
    contextMenu = {
      visible: true,
      x: e.clientX,
      y: e.clientY,
      target: path
    };
  }

  function closeContextMenu() {
    if (contextMenu.visible) contextMenu.visible = false;
  }

  function renameFile(oldPath: string) {
    contextMenu.visible = false;
    const newName = prompt(`Rename ${oldPath} to:`, oldPath);
    if (!newName || newName === oldPath) return;
    const cleanPath = newName.trim().replace(/\\/g, '/');
    if (fileContents[cleanPath] && cleanPath !== oldPath) {
      alert(`File "${cleanPath}" already exists.`);
      return;
    }
    fileContents[cleanPath] = fileContents[oldPath];
    delete fileContents[oldPath];

    fileList = Object.keys(fileContents);
    selectedFiles = selectedFiles.map(f => f === oldPath ? cleanPath : f);

    if (activeFileName === oldPath) activeFileName = cleanPath;
    if (entryFileName === oldPath) entryFileName = cleanPath;
  }

  function duplicateFile(srcPath: string) {
    contextMenu.visible = false;
    const ext = srcPath.includes('.') ? '.' + srcPath.split('.').pop() : '';
    const base = srcPath.replace(/\.[^/.]+$/, '');
    const newPath = `${base}_copy${ext}`;
    fileContents[newPath] = fileContents[srcPath] || '';
    fileList = Object.keys(fileContents);
    selectedFiles = [newPath];
    switchFile(newPath);
  }

  function handleFileNodeClick(e: MouseEvent, path: string) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (selectedFiles.includes(path)) {
        if (selectedFiles.length > 1) {
          selectedFiles = selectedFiles.filter(f => f !== path);
        }
      } else {
        selectedFiles = [...selectedFiles, path];
        switchFile(path);
      }
    } else {
      selectedFiles = [path];
      switchFile(path);
    }
  }

  function deleteFile(name: string) {
    if (fileList.length <= 1) {
      alert('Cannot delete the last remaining file in the project.');
      return;
    }
    if (confirm(`Are you sure you want to delete ${name}?`)) {
      delete fileContents[name];
      fileList = Object.keys(fileContents);
      selectedFiles = selectedFiles.filter(f => f !== name);
      if (selectedFiles.length === 0) {
        selectedFiles = [fileList[0]];
      }
      if (activeFileName === name) {
        switchFile(fileList[0]);
      }
      if (entryFileName === name) {
        entryFileName = fileList[0];
      }
    }
  }

  function deleteSelectedFiles() {
    contextMenu.visible = false;
    if (fileList.length <= selectedFiles.length) {
      alert('Cannot delete all files in the project.');
      return;
    }
    if (confirm(`Are you sure you want to delete ${selectedFiles.length} selected files?`)) {
      for (const f of selectedFiles) {
        delete fileContents[f];
      }
      fileList = Object.keys(fileContents);
      const nextFile = fileList[0];
      selectedFiles = [nextFile];
      if (!fileContents[activeFileName]) {
        switchFile(nextFile);
      }
      if (!fileContents[entryFileName]) {
        entryFileName = nextFile;
      }
    }
  }

  // Quick Flags Helper State
  let flagDebug = $state('3');
  let flagOptimize = $state('2');
  let flagCompat = $state(true);
  let flagSemicolon = $state(true);
  let flagStackSize = $state('65536');

  function updateFlagsFromControls() {
    const parts = [
      `-d${flagDebug}`,
      `-O${flagOptimize}`,
      flagCompat ? '-Z+' : '-Z-',
      flagSemicolon ? '-;+' : '-;-',
      `-S${flagStackSize}`
    ];
    compilerFlags = parts.join(' ');
  }

  function createEditorState(initialDoc: string) {
    return EditorState.create({
      doc: initialDoc,
      extensions: [
        basicSetup,
        cpp(),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            fileContents[activeFileName] = update.state.doc.toString();
          }
        }),
        EditorView.theme({
          "&": { height: "100%", fontSize: "13.5px", fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace", backgroundColor: "#070709", color: "#FFFFFF" },
          ".cm-scroller": { overflow: "auto" },
          ".cm-content": { caretColor: "#FFC799" },
          ".cm-cursor": { borderLeftColor: "#FFC799" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(255, 199, 153, 0.25) !important" },
          ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.03)" },
          ".cm-activeLineGutter": { backgroundColor: "rgba(255, 255, 255, 0.05)", color: "#FFFFFF" },
          ".cm-gutters": { backgroundColor: "#070709", color: "#52525B", borderRight: "1px solid #181922" }
        })
      ]
    });
  }

  onMount(async () => {
    const rootUrl = new URL('.', window.location.href).href;

    // 1. Fetch available standard includes list
    try {
      const incRes = await fetch(new URL('includes.json', rootUrl).href);
      if (incRes.ok) {
        const data = await incRes.json();
        availableIncludes = Object.keys(data).sort();
        includeCount = availableIncludes.length;
      }
    } catch (_) {}

    // 2. Initialize CodeMirror with clean EditorState
    const startCode = fileContents[activeFileName] || '';
    const state = createEditorState(startCode);

    editorView = new EditorView({
      state,
      parent: editorContainer
    });

    // 3. Initialize Web Worker
    worker = new Worker(new URL('./lib/pawn.worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (e) => {
      const { type, includeCount: count, success, stdout, stderr, amx, outputFileName } = e.data;
      if (type === 'ready') {
        isWorkerReady = true;
        includeCount = count;
        consoleOutput = `[Engine Ready] Pawn Compiler v3.10.11 WebAssembly initialized.\nLoaded ${count} standard & open.mp include headers.\nReady for compilation.\n`;
      } else if (type === 'compile_result') {
        isCompiling = false;
        compileStatus = success ? 'success' : 'error';

        // Parse diagnostics (errors & warnings)
        const diags: { type: 'error' | 'warning'; file: string; line: number; code: string; message: string }[] = [];
        const rawOutput = (stdout ? stdout + '\n' : '') + (stderr || '');
        consoleOutput = rawOutput || (success ? 'Compilation succeeded without warnings or errors.' : 'Compilation failed.');

        const diagRegex = /(?:.*?\/workspace\/|.*?\/include\/|)([^\s()]+\.[a-zA-Z0-9]+)\((\d+)(?:\s*--\s*\d+)?\)\s*:\s*(error|warning)\s*(\d+):\s*(.*)/g;
        let match;
        while ((match = diagRegex.exec(rawOutput)) !== null) {
          diags.push({
            file: match[1],
            line: parseInt(match[2], 10),
            type: match[3] as 'error' | 'warning',
            code: match[4],
            message: match[5].trim()
          });
        }
        diagnostics = diags;
        if (diags.length > 0) {
          activeOutputView = 'issues';
        } else if (!success) {
          activeOutputView = 'terminal';
        }

        if (amxBlobUrl) {
          URL.revokeObjectURL(amxBlobUrl);
          amxBlobUrl = null;
          amxSizeFormatted = null;
        }

        if (amx && amx.length > 0) {
          const blob = new Blob([amx], { type: 'application/octet-stream' });
          amxBlobUrl = URL.createObjectURL(blob);
          downloadedFileName = outputFileName || 'gamemode.amx';

          const bytes = amx.length;
          if (bytes > 1024 * 1024) {
            amxSizeFormatted = (bytes / (1024 * 1024)).toFixed(2) + ' MB';
          } else {
            amxSizeFormatted = (bytes / 1024).toFixed(1) + ' KB';
          }
        }
      }
    };

    worker.postMessage({ type: 'init', baseUrl: rootUrl });

    // Hotkey: Ctrl+S or F5 to compile
    const handleKeydown = (e: KeyboardEvent) => {
      if ((e.ctrlKey && e.key === 's') || e.key === 'F5') {
        e.preventDefault();
        compileCode();
      }
    };
    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('click', closeContextMenu);

    return () => {
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('click', closeContextMenu);
      worker?.terminate();
      if (amxBlobUrl) URL.revokeObjectURL(amxBlobUrl);
    };
  });

  // Switch active file in editor cleanly via setState
  function switchFile(filename: string) {
    if (editorView && activeFileName && fileContents[activeFileName] !== undefined) {
      fileContents[activeFileName] = editorView.state.doc.toString();
    }
    if (filename === activeFileName) return;
    activeFileName = filename;
    if (editorView) {
      const code = fileContents[filename] || '';
      editorView.setState(createEditorState(code));
      editorView.focus();
    }
  }

  // Load a preset template
  function loadTemplate(name: string) {
    currentTemplate = name;
    const tmpl = TEMPLATES[name];
    if (!tmpl) return;

    fileContents = { ...tmpl.files };
    fileList = Object.keys(tmpl.files);
    activeFileName = tmpl.entry;
    entryFileName = tmpl.entry;
    selectedFiles = [tmpl.entry];

    if (editorView) {
      editorView.setState(createEditorState(fileContents[activeFileName] || ''));
      editorView.focus();
    }
  }

  // Create new file
  function createNewFile() {
    const name = prompt('Enter relative file path (e.g. modules/admin.pwn or api/helper.inc):');
    if (!name) return;
    const cleanPath = name.trim().replace(/\\/g, '/');
    if (!fileContents[cleanPath]) {
      fileContents[cleanPath] = `// ${cleanPath}\n\n`;
    }
    fileList = Object.keys(fileContents);
    selectedFiles = [cleanPath];
    switchFile(cleanPath);
  }

  // Set file as compilation target
  function setAsEntry(name: string) {
    entryFileName = name;
  }

  // Handle uploading a single .pwn or .inc file
  async function handleSinglePwnUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const text = await file.text();
    fileContents[file.name] = text;
    fileList = Object.keys(fileContents);
    entryFileName = file.name;
    selectedFiles = [file.name];
    switchFile(file.name);
    input.value = '';
  }

  // Handle opening a project folder via webkitdirectory
  async function handleFolderUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const newFiles: Record<string, string> = {};
    let candidateEntry = '';

    for (const file of Array.from(input.files)) {
      const relPath = (file.webkitRelativePath || file.name).replace(/^[^\/]+\//, '');
      if (file.name.endsWith('.pwn') || file.name.endsWith('.inc')) {
        const text = await file.text();
        newFiles[relPath] = text;
        if (!candidateEntry && relPath.endsWith('.pwn')) {
          candidateEntry = relPath;
        }
      }
    }

    input.value = '';

    if (Object.keys(newFiles).length === 0) {
      alert('No .pwn or .inc files found in selected folder.');
      return;
    }

    fileContents = newFiles;
    fileList = Object.keys(newFiles);
    entryFileName = candidateEntry || fileList[0];
    selectedFiles = [entryFileName];
    switchFile(entryFileName);
  }

  // Handle uploading custom includes folder (e.g. YSI or custom pawno/include)
  async function handleIncludeFolderUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const newIncludes = { ...customIncludes };
    let count = 0;

    for (const file of Array.from(input.files)) {
      const relPath = (file.webkitRelativePath || file.name).replace(/^[^\/]+\//, '');
      if (file.name.endsWith('.inc') || file.name.endsWith('.h')) {
        const text = await file.text();
        newIncludes[relPath] = text;
        count++;
      }
    }

    input.value = '';
    customIncludes = newIncludes;
    alert(`Successfully imported ${count} include files into virtual /include/!`);
  }

  function compileCode() {
    if (!editorView || !worker || isCompiling) return;

    // Save current active editor text to fileContents
    fileContents[activeFileName] = editorView.state.doc.toString();

    isCompiling = true;
    isOutputOpen = true;
    compileStatus = 'idle';
    consoleOutput = `Compiling project [Target: ${entryFileName}]...\nFlags: ${compilerFlags}\n\n`;
    diagnostics = [];

    const extraArgs = compilerFlags.split(' ').map(s => s.trim()).filter(Boolean);

    const rootUrl = new URL('.', window.location.href).href;

    worker.postMessage({
      type: 'compile',
      baseUrl: rootUrl,
      payload: {
        files: { ...fileContents },
        entryFile: entryFileName,
        customIncludes: $state.snapshot(customIncludes),
        args: extraArgs
      }
    });
  }

  function jumpToDiagnostic(file: string, lineNumber: number) {
    const matchedKey = fileList.find(k => k === file || k.endsWith(file));
    if (matchedKey && matchedKey !== activeFileName) {
      selectedFiles = [matchedKey];
      switchFile(matchedKey);
    }

    setTimeout(() => {
      if (!editorView) return;
      try {
        const line = editorView.state.doc.line(lineNumber);
        editorView.dispatch({
          selection: { anchor: line.from },
          scrollIntoView: true
        });
        editorView.focus();
      } catch (_) {}
    }, 50);
  }
</script>

<div class="ide-root">
  <!-- Top Application Bar -->
  <header class="app-header">
    <div class="brand-section">
      <div class="brand-logo" title="Pawn Studio Web">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="brand-icon">
          <circle cx="12" cy="5.5" r="3" />
          <path d="M9 10h6" />
          <path d="M10 10c0 2.8-2 4.8-2.5 7.5h9c-.5-2.7-2.5-4.7-2.5-7.5" />
          <rect x="6" y="17.5" width="12" height="2.5" rx="0.8" />
          <path d="M5 21h14" />
        </svg>
      </div>
      <div class="brand-text">
        <span class="brand-title">Pawn Studio Web</span>
        <span class="brand-badge">WASM 3.10.11</span>
      </div>
      <div class="engine-status {isWorkerReady ? 'online' : 'loading'}">
        <span class="status-dot"></span>
        <span>{isWorkerReady ? 'Engine Ready' : 'Initializing Engine...'}</span>
      </div>
    </div>

    <div class="actions-section">
      <!-- Template Selector -->
      <div class="dropdown-control">
        <Layers size={14} class="control-icon" />
        <select bind:value={currentTemplate} onchange={() => loadTemplate(currentTemplate)}>
          {#each Object.keys(TEMPLATES) as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </div>

      <!-- Quick Flags Button -->
      <button 
        class="btn-icon-label" 
        onclick={() => showFlagsModal = !showFlagsModal}
        title="Configure Compiler Flags (-d, -O, -Z, -S)"
      >
        <SlidersHorizontal size={14} />
        <span>Flags</span>
      </button>

      <!-- Toggle Problems & Output Panel -->
      <button 
        class="btn-icon-label {isOutputOpen ? 'active' : ''}" 
        onclick={() => isOutputOpen = !isOutputOpen}
        title="Toggle Problems & Output Panel"
      >
        {#if errorCount > 0}
          <AlertCircle size={14} class="rail-icon error" />
          <span>Problems ({errorCount})</span>
        {:else if warningCount > 0}
          <AlertTriangle size={14} class="rail-icon warning" />
          <span>Problems ({warningCount})</span>
        {:else}
          <Terminal size={14} />
          <span>{isOutputOpen ? 'Hide Panel' : 'Panel'}</span>
        {/if}
      </button>

      <!-- Primary Compile Button -->
      <button 
        class="btn-primary-compile {isCompiling ? 'loading' : ''}" 
        onclick={compileCode} 
        disabled={!isWorkerReady || isCompiling}
      >
        {#if isCompiling}
          <div class="loader-spinner"></div>
          <span>Compiling...</span>
        {:else}
          <Play size={14} fill="currentColor" />
          <span>Compile</span>
          <kbd class="shortcut-tag">F5</kbd>
        {/if}
      </button>

      <!-- Download Button -->
      {#if amxBlobUrl}
        <a class="btn-download-amx" href={amxBlobUrl} download={downloadedFileName}>
          <Download size={14} />
          <span>Download</span>
          {#if amxSizeFormatted}
            <span class="size-pill">{amxSizeFormatted}</span>
          {/if}
        </a>
      {/if}
    </div>
  </header>

  <!-- Compiler Flags Config Modal / Popover -->
  {#if showFlagsModal}
    <div class="modal-backdrop" onclick={() => showFlagsModal = false} role="presentation">
      <div class="modal-card" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && (showFlagsModal = false)} role="dialog" tabindex="-1" aria-modal="true">
        <div class="modal-header">
          <div class="modal-title">
            <SlidersHorizontal size={16} />
            <span>Compiler Options & Flags</span>
          </div>
          <button class="btn-close" onclick={() => showFlagsModal = false}><X size={16} /></button>
        </div>

        <div class="modal-body">
          <div class="form-row">
            <label for="flag-debug">Debug Information (-d):</label>
            <select id="flag-debug" bind:value={flagDebug} onchange={updateFlagsFromControls}>
              <option value="0">0 - None (Production)</option>
              <option value="1">1 - Run-time checks only</option>
              <option value="2">2 - Full debug symbols</option>
              <option value="3">3 - Max debug & diagnostics (-d3)</option>
            </select>
          </div>

          <div class="form-row">
            <label for="flag-opt">Optimization Level (-O):</label>
            <select id="flag-opt" bind:value={flagOptimize} onchange={updateFlagsFromControls}>
              <option value="0">0 - No optimization</option>
              <option value="1">1 - JIT-compatible</option>
              <option value="2">2 - Full optimizations (-O2)</option>
            </select>
          </div>

          <div class="form-row">
            <label for="flag-stack">Stack / Heap Cells (-S):</label>
            <select id="flag-stack" bind:value={flagStackSize} onchange={updateFlagsFromControls}>
              <option value="16384">16384 (Default 16 KB)</option>
              <option value="32768">32768 (32 KB)</option>
              <option value="65536">65536 (Recommended 64 KB)</option>
              <option value="131072">131072 (Large 128 KB)</option>
            </select>
          </div>

          <div class="form-toggle-row">
            <label>
              <input type="checkbox" bind:checked={flagCompat} onchange={updateFlagsFromControls} />
              <span>Compatibility Mode (-Z+)</span>
            </label>
            <label>
              <input type="checkbox" bind:checked={flagSemicolon} onchange={updateFlagsFromControls} />
              <span>Require Semicolons (-;+)</span>
            </label>
          </div>

          <div class="form-raw-row">
            <label for="raw-flags">Raw Command Line Flags:</label>
            <input id="raw-flags" type="text" bind:value={compilerFlags} class="code-input" />
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-modal-done" onclick={() => showFlagsModal = false}>Done</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Main Multi-Pane IDE Workspace with Left Activity Rail -->
  <div class="ide-workspace {isOutputOpen ? 'has-output' : 'editor-fullscreen'}">
    <!-- 1. Left Activity Rail Dock (46px) -->
    <nav class="activity-rail" aria-label="Activity Rail">
      <div class="rail-group-top">
        <button 
          class="rail-item {activityTab === 'explorer' ? 'active' : ''}" 
          onclick={() => activityTab = 'explorer'}
          title="Explorer (Project Files)"
        >
          <FolderTree size={18} />
          <span class="rail-tooltip">Explorer</span>
        </button>
        <button 
          class="rail-item {activityTab === 'includes' ? 'active' : ''}" 
          onclick={() => activityTab = 'includes'}
          title="Includes Manager"
        >
          <Package size={18} />
          {#if includeCount > 0}
            <span class="rail-badge">{includeCount}</span>
          {/if}
          <span class="rail-tooltip">Includes</span>
        </button>
        <button 
          class="rail-item {activityTab === 'settings' ? 'active' : ''}" 
          onclick={() => activityTab = 'settings'}
          title="Compiler Config & Flags"
        >
          <SlidersHorizontal size={18} />
          <span class="rail-tooltip">Settings</span>
        </button>
      </div>

      <div class="rail-group-bottom">
        <button 
          class="rail-item {isOutputOpen ? 'active' : ''}" 
          onclick={() => isOutputOpen = !isOutputOpen}
          title={isOutputOpen ? "Collapse Problems Panel" : "Open Problems Panel"}
        >
          {#if errorCount > 0}
            <AlertCircle size={18} class="rail-icon error" />
            <span class="rail-badge error">{errorCount}</span>
          {:else if warningCount > 0}
            <AlertTriangle size={18} class="rail-icon warning" />
            <span class="rail-badge warning">{warningCount}</span>
          {:else}
            <Terminal size={18} />
          {/if}
          <span class="rail-tooltip">Problems & Console</span>
        </button>
      </div>
    </nav>

    <!-- 2. Active Sidebar Drawer (260px) -->
    <aside class="sidebar-pane">
      {#if activityTab === 'explorer'}
        <!-- Project Files Tree & Upload Actions -->
        <div class="sidebar-top">
          <div class="sidebar-title">
            <FolderTree size={14} class="title-icon" />
            <span>PROJECT FILES</span>
            <span class="count-badge">{fileList.length}</span>
          </div>
          <button class="btn-icon-subtle" onclick={createNewFile} title="Add New File">
            <FilePlus size={14} />
          </button>
        </div>

        <div class="file-list-view">
          {#each sortedFileList as path (path)}
            <div 
              class="file-node {activeFileName === path ? 'active' : ''} {selectedFiles.includes(path) ? 'selected' : ''}"
              oncontextmenu={(e) => onContextMenu(e, path)}
              role="listitem"
            >
              <div 
                class="file-node-main"
                role="button"
                tabindex="0"
                onclick={(e) => handleFileNodeClick(e, path)}
                onkeydown={(e) => e.key === 'Enter' && switchFile(path)}
                title="Click to open. Ctrl+Click to multi-select. Right-click for options."
              >
                {#if path.endsWith('.pwn')}
                  <FileCode size={15} class="node-icon pwn" />
                {:else}
                  <FileText size={15} class="node-icon inc" />
                {/if}
                <span class="node-name" title={path}>{path}</span>
                {#if entryFileName === path}
                  <span class="target-tag" title="Main Compiler Target">ENTRY</span>
                {/if}
              </div>

              <div class="node-hover-actions">
                {#if entryFileName !== path && path.endsWith('.pwn')}
                  <button 
                    class="btn-hover-tag" 
                    onclick={() => setAsEntry(path)} 
                    title="Set as compilation entry point"
                  >
                    Target
                  </button>
                {/if}
                <button 
                  class="btn-hover-icon danger" 
                  onclick={() => deleteFile(path)} 
                  title="Delete file"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          {/each}
        </div>

        <div class="sidebar-bottom-actions">
          <!-- 1. Upload single .pwn -->
          <input 
            type="file" 
            bind:this={singlePwnInput} 
            onchange={handleSinglePwnUpload} 
            accept=".pwn,.inc"
            style="display: none" 
          />
          <button class="btn-action-tile" onclick={() => singlePwnInput.click()}>
            <FileUp size={14} />
            <span>Upload .pwn</span>
          </button>

          <!-- 2. Upload full gamemode project folder -->
          <input 
            type="file" 
            bind:this={folderInput} 
            onchange={handleFolderUpload} 
            style="display: none" 
            webkitdirectory 
            multiple 
          />
          <button class="btn-action-tile" onclick={() => folderInput.click()}>
            <FolderOpen size={14} />
            <span>Upload Project</span>
          </button>

          <!-- 3. Upload includes folder -->
          <input 
            type="file" 
            bind:this={includeFolderInput} 
            onchange={handleIncludeFolderUpload} 
            style="display: none" 
            webkitdirectory 
            multiple 
          />
          <button class="btn-action-tile secondary" onclick={() => includeFolderInput.click()}>
            <Package size={14} />
            <span>Upload Includes</span>
          </button>
        </div>
      {:else if activityTab === 'includes'}
        <!-- Mounted Includes Manager View -->
        <div class="sidebar-top">
          <div class="sidebar-title">
            <Package size={14} class="title-icon" />
            <span>INCLUDES</span>
            <span class="count-badge">{availableIncludes.length + Object.keys(customIncludes).length}</span>
          </div>
          <button class="btn-icon-subtle" onclick={() => includeFolderInput.click()} title="Upload Custom Includes Folder">
            <FileUp size={14} />
          </button>
        </div>

        <div class="sidebar-search-box">
          <Search size={13} class="search-icon" />
          <input 
            type="text" 
            bind:value={includeSearch} 
            placeholder="Search headers..." 
            class="sidebar-search-input"
          />
          {#if includeSearch}
            <button class="btn-search-clear" onclick={() => includeSearch = ''}><X size={12} /></button>
          {/if}
        </div>

        <div class="subtab-bar">
          <button 
            class="subtab-btn {includesSubTab === 'standard' ? 'active' : ''}"
            onclick={() => includesSubTab = 'standard'}
          >
            <span>Standard ({availableIncludes.length})</span>
          </button>
          <button 
            class="subtab-btn {includesSubTab === 'custom' ? 'active' : ''}"
            onclick={() => includesSubTab = 'custom'}
          >
            <span>Custom ({Object.keys(customIncludes).length})</span>
          </button>
        </div>

        <div class="includes-sidebar-list">
          {#if includesSubTab === 'standard'}
            {#each filteredStandardIncludes as inc}
              <div class="include-sidebar-item">
                <FileCode size={13} class="inc-file-icon" />
                <span class="inc-file-name" title={inc}>{inc}</span>
              </div>
            {/each}
          {:else}
            {#if Object.keys(customIncludes).length === 0}
              <div class="empty-includes-notice">
                <Package size={22} />
                <span>No custom includes uploaded yet.</span>
                <button class="btn-subtle-upload" onclick={() => includeFolderInput.click()}>
                  Upload folder
                </button>
              </div>
            {:else}
              {#each filteredCustomIncludes as inc}
                <div class="include-sidebar-item custom">
                  <FileText size={13} class="inc-file-icon custom" />
                  <span class="inc-file-name" title={inc}>{inc}</span>
                </div>
              {/each}
            {/if}
          {/if}
        </div>
      {:else if activityTab === 'settings'}
        <!-- Inline Compiler Settings View -->
        <div class="sidebar-top">
          <div class="sidebar-title">
            <SlidersHorizontal size={14} class="title-icon" />
            <span>COMPILER CONFIG</span>
          </div>
        </div>

        <div class="sidebar-settings-panel">
          <div class="settings-group">
            <label for="flag-debug-sidebar">Debug Level (-d):</label>
            <select id="flag-debug-sidebar" bind:value={flagDebug} onchange={updateFlagsFromControls}>
              <option value="0">0 - None (Production)</option>
              <option value="1">1 - Run-time checks only</option>
              <option value="2">2 - Full debug symbols</option>
              <option value="3">3 - Max debug & diagnostics (-d3)</option>
            </select>
          </div>

          <div class="settings-group">
            <label for="flag-opt-sidebar">Optimization Level (-O):</label>
            <select id="flag-opt-sidebar" bind:value={flagOptimize} onchange={updateFlagsFromControls}>
              <option value="0">0 - No optimization</option>
              <option value="1">1 - JIT-compatible</option>
              <option value="2">2 - Full optimizations (-O2)</option>
            </select>
          </div>

          <div class="settings-group">
            <label for="flag-stack-sidebar">Stack / Heap Cells (-S):</label>
            <select id="flag-stack-sidebar" bind:value={flagStackSize} onchange={updateFlagsFromControls}>
              <option value="16384">16384 (16 KB)</option>
              <option value="32768">32768 (32 KB)</option>
              <option value="65536">65536 (64 KB)</option>
              <option value="131072">131072 (128 KB)</option>
            </select>
          </div>

          <div class="settings-checkboxes">
            <label class="setting-check">
              <input type="checkbox" bind:checked={flagCompat} onchange={updateFlagsFromControls} />
              <span>Compatibility Mode (-Z+)</span>
            </label>
            <label class="setting-check">
              <input type="checkbox" bind:checked={flagSemicolon} onchange={updateFlagsFromControls} />
              <span>Require Semicolons (-;+)</span>
            </label>
          </div>

          <div class="settings-group">
            <label for="raw-flags-sidebar">Raw Arguments:</label>
            <input id="raw-flags-sidebar" type="text" bind:value={compilerFlags} class="code-input" />
          </div>
        </div>
      {/if}
    </aside>

    <!-- 3. Center Code Editor Pane -->
    <section class="editor-pane">
      <div class="editor-tab-bar">
        <div class="active-tab-chip">
          {#if activeFileName.endsWith('.pwn')}
            <FileCode size={13} class="tab-icon pwn" />
          {:else}
            <FileText size={13} class="tab-icon inc" />
          {/if}
          <span class="tab-filename">{activeFileName}</span>
          {#if entryFileName === activeFileName}
            <span class="tab-target-badge">ENTRY POINT</span>
          {/if}
        </div>
        <div class="editor-right-hint">
          <kbd>Ctrl+S</kbd> or <kbd>F5</kbd> to compile
        </div>
      </div>

      <!-- CodiLime Breadcrumb Bar -->
      <div class="breadcrumb-bar">
        <span class="breadcrumb-root">project</span>
        {#each breadcrumbs as chunk, idx}
          <span class="breadcrumb-sep">/</span>
          <span class="breadcrumb-chunk {idx === breadcrumbs.length - 1 ? 'active' : ''}">{chunk}</span>
        {/each}
      </div>

      <div class="editor-core-container" bind:this={editorContainer}></div>

      <!-- Editor Bottom Status Bar -->
      <footer class="editor-status-bar">
        <div class="status-left">
          <span class="status-item"><FileCheck size={12} /> {activeFileName}</span>
          <span class="status-item">Pawn 3.10.11</span>
          <span class="status-item">UTF-8</span>
          <span class="status-item">Spaces: 4</span>
        </div>
        <div class="status-right">
          {#if amxSizeFormatted}
            <span class="status-item highlight"><HardDrive size={12} /> AMX: {amxSizeFormatted}</span>
          {/if}
          <span class="status-item"><Package size={12} /> {includeCount} mounted</span>
        </div>
      </footer>
    </section>

    <!-- 4. Right Output & Diagnostics Panel (CodiLime Style) -->
    {#if isOutputOpen}
      <section class="output-pane">
        <div class="output-tab-header">
          <div class="diagnostics-filters">
            <button 
              class="filter-pill {activeOutputView === 'issues' && diagnosticsFilter === 'all' ? 'active' : ''}"
              onclick={() => { activeOutputView = 'issues'; diagnosticsFilter = 'all'; }}
            >
              <span>All</span>
              <span class="pill-count">{diagnostics.length}</span>
            </button>
            <button 
              class="filter-pill {activeOutputView === 'issues' && diagnosticsFilter === 'errors' ? 'active' : ''} {errorCount > 0 ? 'has-danger' : ''}"
              onclick={() => { activeOutputView = 'issues'; diagnosticsFilter = 'errors'; }}
            >
              <span>Errors</span>
              <span class="pill-count danger">{errorCount}</span>
            </button>
            <button 
              class="filter-pill {activeOutputView === 'issues' && diagnosticsFilter === 'warnings' ? 'active' : ''} {warningCount > 0 ? 'has-warning' : ''}"
              onclick={() => { activeOutputView = 'issues'; diagnosticsFilter = 'warnings'; }}
            >
              <span>Warnings</span>
              <span class="pill-count warning">{warningCount}</span>
            </button>
            <button 
              class="filter-pill {activeOutputView === 'raw' ? 'active' : ''}"
              onclick={() => activeOutputView = 'raw'}
            >
              <Terminal size={12} />
              <span>Terminal</span>
            </button>
          </div>
        </div>

        {#if activeOutputView === 'issues'}
          <!-- CodiLime Interactive Diagnostics Cards Feed -->
          <div class="codilime-feed" role="region" aria-label="Compiler Diagnostics">
            {#if filteredDiagnostics.length === 0}
              <div class="empty-diagnostics">
                <CheckCircle2 size={32} class="empty-check-icon" />
                <span class="empty-title">
                  {compileStatus === 'success' ? 'All Checks Passed' : 'No Problems Detected'}
                </span>
                <span class="empty-desc">
                  {compileStatus === 'success' ? 'Compiled cleanly with zero warnings or errors.' : 'Press F5 or Compile to inspect diagnostics.'}
                </span>
              </div>
            {:else}
              {#each filteredDiagnostics as diag}
                <div 
                  class="codilime-card {diag.type}" 
                  role="button" 
                  tabindex="0"
                  onclick={() => jumpToDiagnostic(diag.file, diag.line)}
                  onkeydown={(e) => e.key === 'Enter' && jumpToDiagnostic(diag.file, diag.line)}
                >
                  <div class="codilime-card-top">
                    <span class="codilime-badge {diag.type}">
                      {#if diag.type === 'error'}
                        <AlertCircle size={12} />
                        ERR {diag.code}
                      {:else}
                        <AlertTriangle size={12} />
                        WARN {diag.code}
                      {/if}
                    </span>
                    <span class="codilime-location">{diag.file}:{diag.line}</span>
                  </div>
                  <div class="codilime-message">{diag.message}</div>
                </div>
              {/each}
            {/if}
          </div>
        {:else}
          <!-- Raw Monospace Terminal Output -->
          <div class="console-wrapper">
            <pre class="terminal-text {compileStatus}">{consoleOutput}</pre>
          </div>
        {/if}
      </section>
    {/if}
  </div>

  <!-- Custom Right-Click Context Menu -->
  {#if contextMenu.visible}
    <div 
      class="context-menu" 
      style="top: {contextMenu.y}px; left: {contextMenu.x}px;"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && (contextMenu.visible = false)}
      role="menu"
      tabindex="-1"
    >
      <div class="context-menu-header">{contextMenu.target}</div>
      <button class="context-item" onclick={() => renameFile(contextMenu.target)}>
        <Pencil size={13} />
        <span>Rename</span>
      </button>
      {#if contextMenu.target.endsWith('.pwn') && entryFileName !== contextMenu.target}
        <button class="context-item" onclick={() => { setAsEntry(contextMenu.target); contextMenu.visible = false; }}>
          <Target size={13} />
          <span>Set as Entry Point</span>
        </button>
      {/if}
      <button class="context-item" onclick={() => duplicateFile(contextMenu.target)}>
        <Copy size={13} />
        <span>Duplicate</span>
      </button>
      <div class="context-divider"></div>
      {#if selectedFiles.length > 1 && selectedFiles.includes(contextMenu.target)}
        <button class="context-item danger" onclick={deleteSelectedFiles}>
          <Trash2 size={13} />
          <span>Delete Selected ({selectedFiles.length} files)</span>
        </button>
      {:else}
        <button class="context-item danger" onclick={() => { deleteFile(contextMenu.target); contextMenu.visible = false; }}>
          <Trash2 size={13} />
          <span>Delete</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background-color: #070709;
    color: #FFFFFF;
    overflow: hidden;
  }

  .ide-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    background-color: #070709;
  }

  /* App Header Bar */
  .app-header {
    height: 48px;
    background-color: #0B0B0E;
    border-bottom: 1px solid #191A23;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    flex-shrink: 0;
    user-select: none;
  }

  .brand-section {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .brand-logo {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: linear-gradient(135deg, #FFC799, #FFAE6B);
    display: flex;
    align-items: center;
    justify-content: center;
    color: #070709;
  }

  .brand-text {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .brand-title {
    font-size: 14px;
    font-weight: 700;
    color: #FFFFFF;
    letter-spacing: -0.2px;
  }

  .brand-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    background-color: #14151D;
    color: #A1A1AA;
    border: 1px solid #232533;
  }

  .engine-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 500;
    padding: 3px 8px;
    border-radius: 12px;
  }
  .engine-status.online { background-color: rgba(16, 185, 129, 0.12); color: #34d399; }
  .engine-status.loading { background-color: rgba(255, 199, 153, 0.15); color: #FFC799; }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: currentColor;
  }

  .actions-section {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .dropdown-control {
    display: flex;
    align-items: center;
    gap: 6px;
    background-color: #14151D;
    border: 1px solid #232533;
    border-radius: 6px;
    padding: 2px 8px;
    color: #E4E4E7;
  }

  .dropdown-control select {
    background: transparent;
    border: none;
    color: #FFFFFF;
    font-size: 12px;
    font-weight: 500;
    outline: none;
    cursor: pointer;
    padding: 4px 0;
  }

  .btn-icon-label {
    display: flex;
    align-items: center;
    gap: 6px;
    background-color: #14151D;
    border: 1px solid #232533;
    color: #E4E4E7;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .btn-icon-label:hover { background-color: #1F212E; color: #FFFFFF; border-color: #2F3346; }

  .btn-primary-compile {
    display: flex;
    align-items: center;
    gap: 8px;
    background: linear-gradient(135deg, #FFC799, #FFAE6B);
    color: #070709;
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s ease;
    box-shadow: 0 2px 8px rgba(255, 199, 153, 0.25);
  }
  .btn-primary-compile:hover:not(:disabled) {
    background: linear-gradient(135deg, #FFAE6B, #FF9944);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(255, 199, 153, 0.35);
  }
  .btn-primary-compile:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .shortcut-tag {
    background-color: rgba(7, 7, 9, 0.2);
    color: #070709;
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 10px;
    font-weight: 800;
    font-family: inherit;
  }

  .btn-download-amx {
    display: flex;
    align-items: center;
    gap: 6px;
    background-color: #059669;
    color: white;
    text-decoration: none;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    transition: all 0.15s ease;
  }
  .btn-download-amx:hover { background-color: #047857; }

  .size-pill {
    background-color: rgba(0, 0, 0, 0.25);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: bold;
  }

  /* Modal Dialog */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(2px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-card {
    background: #0E0F14;
    border: 1px solid #232533;
    border-radius: 8px;
    width: 440px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid #191A23;
  }
  .modal-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: #FFFFFF;
  }
  .btn-close {
    background: transparent;
    border: none;
    color: #A1A1AA;
    cursor: pointer;
  }
  .btn-close:hover { color: #FFFFFF; }

  .modal-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .form-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 12px;
    color: #A1A1AA;
  }
  .form-row select, .code-input {
    background: #14151D;
    border: 1px solid #232533;
    color: #FFFFFF;
    border-radius: 4px;
    padding: 6px 10px;
    font-size: 12px;
  }
  .code-input { font-family: monospace; width: 100%; }

  .form-toggle-row {
    display: flex;
    gap: 20px;
    font-size: 12px;
    color: #E4E4E7;
  }
  .form-toggle-row label {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  .modal-footer {
    padding: 10px 16px;
    border-top: 1px solid #191A23;
    display: flex;
    justify-content: flex-end;
  }
  .btn-modal-done {
    background: #FFC799;
    color: #070709;
    border: none;
    padding: 6px 16px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .btn-modal-done:hover {
    background: #FFAE6B;
  }

  /* IDE Main Layout */
  .ide-workspace {
    display: grid;
    grid-template-columns: 46px 260px 1fr 420px;
    flex: 1;
    overflow: hidden;
  }
  .ide-workspace.editor-fullscreen {
    grid-template-columns: 46px 260px 1fr;
  }

  /* 1. Activity Rail (46px Dock) */
  .activity-rail {
    background: #0A0A0D;
    border-right: 1px solid #191A23;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    padding: 8px 0;
    user-select: none;
    z-index: 10;
  }

  .rail-group-top, .rail-group-bottom {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100%;
  }

  .rail-item {
    position: relative;
    background: transparent;
    border: none;
    color: #71717A;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .rail-item:hover {
    color: #FFFFFF;
    background: rgba(255, 255, 255, 0.06);
  }
  .rail-item.active {
    color: #FFC799;
    background: rgba(255, 199, 153, 0.12);
  }
  .rail-item.active::before {
    content: '';
    position: absolute;
    left: -5px;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 4px 4px 0;
    background-color: #FFC799;
  }

  .rail-badge {
    position: absolute;
    top: 2px;
    right: 2px;
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 10px;
    background: #232533;
    color: #FFFFFF;
  }
  .rail-badge.error { background: #ef4444; color: white; }
  .rail-badge.warning { background: #FFC799; color: #070709; }

  .rail-icon.error { color: #ef4444; }
  .rail-icon.warning { color: #FFC799; }

  /* Tooltip on hover */
  .rail-tooltip {
    display: none;
    position: absolute;
    left: 48px;
    background: #0E0F14;
    border: 1px solid #232533;
    color: #FFFFFF;
    padding: 4px 8px;
    font-size: 11px;
    border-radius: 4px;
    white-space: nowrap;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    pointer-events: none;
  }
  .rail-item:hover .rail-tooltip { display: block; }

  /* 2. Left Sidebar Pane */
  .sidebar-pane {
    background: #0D0E12;
    border-right: 1px solid #191A23;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sidebar-top {
    padding: 10px 14px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #191A23;
  }
  .sidebar-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 700;
    color: #71717A;
    letter-spacing: 0.5px;
  }
  .count-badge {
    background: #191A23;
    color: #A1A1AA;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 10px;
  }

  .btn-icon-subtle {
    background: transparent;
    border: none;
    color: #A1A1AA;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .btn-icon-subtle:hover { background: #191A23; color: #FFFFFF; }

  .file-list-view {
    flex: 1;
    overflow-y: auto;
    padding: 6px 0;
  }

  .file-node {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 12px;
    font-size: 12px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    cursor: pointer;
    border-left: 2px solid transparent;
  }
  .file-node:hover { background-color: #14151D; }
  .file-node.selected {
    background-color: rgba(255, 199, 153, 0.12);
    border-left-color: #FFC799;
    color: #FFFFFF;
  }
  .file-node.active {
    background-color: #171822;
    border-left-color: #FFC799;
    color: #FFFFFF;
  }
  .file-node.active.selected {
    background-color: rgba(255, 199, 153, 0.22);
    border-left-color: #FFC799;
    color: #FFFFFF;
  }

  .file-node-main {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    overflow: hidden;
  }
  .node-icon.pwn { color: #FFC799; }
  .node-icon.inc { color: #FBBF24; }
  .node-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .target-tag {
    background-color: #064E3B;
    color: #34D399;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
  }

  .node-hover-actions {
    display: none;
    align-items: center;
    gap: 4px;
  }
  .file-node:hover .node-hover-actions { display: flex; }

  .btn-hover-tag {
    background: #191A23;
    border: 1px solid #282B3A;
    color: #D4D4D8;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    cursor: pointer;
  }
  .btn-hover-tag:hover { background: #232533; color: #FFFFFF; }

  .btn-hover-icon {
    background: transparent;
    border: none;
    color: #71717A;
    cursor: pointer;
    padding: 2px;
    border-radius: 3px;
  }
  .btn-hover-icon.danger:hover { color: #EF4444; background: rgba(239, 68, 68, 0.15); }

  .sidebar-bottom-actions {
    padding: 10px;
    border-top: 1px solid #191A23;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .btn-action-tile {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #13141B;
    border: 1px solid #1F212C;
    color: #E4E4E7;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
  }
  .btn-action-tile:hover { background: #191B24; color: #FFFFFF; border-color: #2D3040; }
  .btn-action-tile.secondary { color: #FFC799; }

  /* Includes Sub-View in Sidebar */
  .sidebar-search-box {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 10px 4px;
    background: #13141B;
    border: 1px solid #1F212C;
    border-radius: 6px;
    padding: 4px 8px;
  }
  .search-icon { color: #71717A; flex-shrink: 0; }
  .sidebar-search-input {
    background: transparent;
    border: none;
    outline: none;
    color: #FFFFFF;
    font-size: 11px;
    width: 100%;
  }
  .btn-search-clear {
    background: transparent;
    border: none;
    color: #71717A;
    cursor: pointer;
    padding: 0;
  }

  .subtab-bar {
    display: flex;
    border-bottom: 1px solid #191A23;
    padding: 0 10px;
    margin-top: 4px;
  }
  .subtab-btn {
    flex: 1;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: #71717A;
    font-size: 11px;
    font-weight: 500;
    padding: 6px 0;
    cursor: pointer;
    text-align: center;
  }
  .subtab-btn.active {
    color: #FFC799;
    border-bottom-color: #FFC799;
    font-weight: 600;
  }

  .includes-sidebar-list {
    flex: 1;
    overflow-y: auto;
    padding: 6px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .include-sidebar-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: #CBD5E1;
    background: rgba(255, 255, 255, 0.02);
  }
  .include-sidebar-item:hover { background: rgba(255, 255, 255, 0.06); }
  .inc-file-icon { color: #FFC799; flex-shrink: 0; }
  .inc-file-icon.custom { color: #34D399; }
  .inc-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .empty-includes-notice {
    padding: 24px 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 8px;
    color: #71717A;
    font-size: 11px;
  }
  .btn-subtle-upload {
    background: #14151D;
    border: 1px solid #232533;
    color: #FFC799;
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    cursor: pointer;
    font-weight: 500;
  }
  .btn-subtle-upload:hover {
    background: #1C1E28;
    color: #FFFFFF;
  }

  /* Inline Compiler Config Panel */
  .sidebar-settings-panel {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }
  .settings-group {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 11px;
    color: #A1A1AA;
  }
  .settings-group select, .settings-group input {
    background: #13141B;
    border: 1px solid #1F212C;
    color: #FFFFFF;
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 11px;
  }
  .settings-checkboxes {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 11px;
    color: #CBD5E1;
  }
  .setting-check {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }

  /* 3. Editor Center Pane */
  .editor-pane {
    display: flex;
    flex-direction: column;
    border-right: 1px solid #191A23;
    overflow: hidden;
    background: #070709;
  }

  .editor-tab-bar {
    height: 36px;
    background: #0A0A0D;
    border-bottom: 1px solid #191A23;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
  }

  .active-tab-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
    color: #FFFFFF;
  }

  .tab-icon.pwn { color: #FFC799; }
  .tab-icon.inc { color: #FBBF24; }

  .tab-target-badge {
    font-size: 9px;
    color: #34D399;
    background: rgba(16, 185, 129, 0.15);
    padding: 1px 5px;
    border-radius: 3px;
  }

  .editor-right-hint {
    font-size: 11px;
    color: #71717A;
  }
  .editor-right-hint kbd {
    background: #14151D;
    padding: 2px 5px;
    border-radius: 3px;
    border: 1px solid #232533;
    color: #A1A1AA;
  }

  /* CodiLime Breadcrumb Navigation Bar */
  .breadcrumb-bar {
    height: 24px;
    background: #0A0A0D;
    border-bottom: 1px solid #191A23;
    display: flex;
    align-items: center;
    padding: 0 12px;
    font-size: 11px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    color: #71717A;
    gap: 4px;
    user-select: none;
  }
  .breadcrumb-root { color: #52525B; font-weight: 500; }
  .breadcrumb-sep { color: #3F3F46; }
  .breadcrumb-chunk.active { color: #FFC799; font-weight: 600; }

  .editor-core-container {
    flex: 1;
    overflow: hidden;
    background: #070709;
  }

  .editor-status-bar {
    height: 24px;
    background: #0A0A0D;
    border-top: 1px solid #191A23;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    font-size: 11px;
    color: #71717A;
  }
  .status-left, .status-right {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .status-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .status-item.highlight { color: #34D399; font-weight: 600; }

  /* 4. Output & Diagnostics Right Pane (CodiLime Style) */
  .output-pane {
    display: flex;
    flex-direction: column;
    background: #0A0A0D;
    overflow: hidden;
  }

  .output-tab-header {
    height: 38px;
    background: #0D0E12;
    border-bottom: 1px solid #191A23;
    display: flex;
    align-items: center;
    padding: 0 10px;
  }

  .diagnostics-filters {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
  }

  .filter-pill {
    display: flex;
    align-items: center;
    gap: 5px;
    background: transparent;
    border: 1px solid transparent;
    color: #A1A1AA;
    padding: 4px 8px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.12s ease;
  }
  .filter-pill:hover { background: rgba(255, 255, 255, 0.05); color: #FFFFFF; }
  .filter-pill.active {
    background: #171822;
    border-color: #FFC799;
    color: #FFFFFF;
    font-weight: 600;
  }

  .pill-count {
    background: #1F212C;
    color: #A1A1AA;
    padding: 1px 5px;
    border-radius: 8px;
    font-size: 10px;
    font-weight: 700;
  }
  .pill-count.danger { background: rgba(239, 68, 68, 0.2); color: #F87171; }
  .pill-count.warning { background: rgba(255, 199, 153, 0.2); color: #FFC799; }
  .filter-pill.has-danger { color: #F87171; }
  .filter-pill.has-warning { color: #FFC799; }

  /* CodiLime Feed */
  .codilime-feed {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .codilime-card {
    background: #111218;
    border: 1px solid #1F212C;
    border-left: 3px solid #FFC799;
    border-radius: 6px;
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;
    transition: all 0.12s ease;
  }
  .codilime-card:hover {
    background: #171822;
    border-color: #2D3040;
    transform: translateY(-1px);
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.4);
  }
  .codilime-card.error {
    border-left-color: #EF4444;
  }
  .codilime-card.warning {
    border-left-color: #FFC799;
  }

  .codilime-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .codilime-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 700;
    font-family: 'JetBrains Mono', monospace;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .codilime-badge.error { background: rgba(239, 68, 68, 0.15); color: #F87171; }
  .codilime-badge.warning { background: rgba(255, 199, 153, 0.15); color: #FFC799; }

  .codilime-location {
    font-size: 11px;
    font-family: 'JetBrains Mono', monospace;
    color: #FFC799;
    font-weight: 500;
  }

  .codilime-message {
    font-size: 12px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    color: #E4E4E7;
    line-height: 1.4;
  }

  .empty-diagnostics {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 60px 20px;
    text-align: center;
    color: #71717A;
    gap: 8px;
  }
  .empty-check-icon { color: #10B981; opacity: 0.8; }
  .empty-title { font-size: 14px; font-weight: 600; color: #FFFFFF; }
  .empty-desc { font-size: 11px; color: #71717A; max-width: 260px; line-height: 1.4; }

  .console-wrapper {
    flex: 1;
    overflow: auto;
    background: #050507;
  }

  .terminal-text {
    margin: 0;
    padding: 12px;
    font-family: 'JetBrains Mono', Consolas, monospace;
    font-size: 12px;
    line-height: 1.45;
    color: #E4E4E7;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .terminal-text.success { color: #86EFAC; }
  .terminal-text.error { color: #FCA5A5; }

  .loader-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(7, 7, 9, 0.3);
    border-radius: 50%;
    border-top-color: #070709;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Custom Context Menu */
  .context-menu {
    position: fixed;
    z-index: 2000;
    background: #0E0F14;
    border: 1px solid #232533;
    border-radius: 6px;
    padding: 4px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    min-width: 170px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    user-select: none;
  }

  .context-menu-header {
    font-size: 10px;
    font-family: 'JetBrains Mono', monospace;
    color: #71717A;
    padding: 4px 8px 3px;
    border-bottom: 1px solid #191A23;
    margin-bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .context-item {
    display: flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: none;
    color: #E4E4E7;
    padding: 6px 10px;
    font-size: 12px;
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    transition: all 0.1s ease;
  }
  .context-item:hover {
    background: #1C1E28;
    color: #FFFFFF;
  }
  .context-item.danger:hover {
    background: rgba(239, 68, 68, 0.15);
    color: #EF4444;
  }

  .context-divider {
    height: 1px;
    background: #191A23;
    margin: 2px 0;
  }
</style>
