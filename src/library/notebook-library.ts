/**
 * NotebookLM Library Manager
 *
 * Manages a persistent library of NotebookLM notebooks.
 * Allows Claude to autonomously add, remove, and switch between
 * multiple notebooks based on the task at hand.
 *
 * Supports per-project libraries based on current working directory.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { CONFIG } from "../config.js";
import { log } from "../utils/logger.js";
import { writeFileSecure, PERMISSION_MODES } from "../utils/file-permissions.js";
import type {
  NotebookEntry,
  Library,
  AddNotebookInput,
  UpdateNotebookInput,
  LibraryStats,
  ProjectInfo,
} from "./types.js";

/**
 * Maximum number of parent directories to walk when detecting a project.
 * An attacker who controls the launch directory could otherwise force a very
 * deep walk; bound it to fail safe to the global library. (M26)
 */
const MAX_PROJECT_WALK_DEPTH = 10;

/**
 * Maximum package.json size we are willing to read+parse during project
 * detection. An attacker controlling the launch dir could drop a huge file to
 * cause a memory spike; cap it and fail safe. (M26)
 */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024; // 1 MB

/**
 * Detect project from current working directory
 */
function detectProject(): ProjectInfo | null {
  const cwd = process.cwd();

  // Priority 1: Git repository root
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    return {
      id: hashPath(gitRoot),
      name: path.basename(gitRoot),
      path: gitRoot,
      type: "git",
    };
  }

  // Priority 2: package.json location
  const pkgRoot = findPackageJson(cwd);
  if (pkgRoot) {
    try {
      const pkgPath = path.join(pkgRoot, "package.json");

      // Cap the file size before reading to avoid a memory spike from an
      // attacker-controlled launch directory. (M26)
      const stat = fs.statSync(pkgPath);
      if (stat.size > MAX_PACKAGE_JSON_BYTES) {
        log.debug(`notebook-library: package.json too large (${stat.size} bytes) — falling back to directory name`);
        return {
          id: hashPath(pkgRoot),
          name: path.basename(pkgRoot),
          path: pkgRoot,
          type: "npm",
        };
      }

      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name?: unknown };
      // Only trust pkg.name when it is actually a string. (M26)
      const name = typeof pkg.name === "string" && pkg.name.length > 0
        ? pkg.name
        : path.basename(pkgRoot);
      return {
        id: hashPath(pkgRoot),
        name,
        path: pkgRoot,
        type: "npm",
      };
    } catch (err) {
      log.debug(`notebook-library: reading package.json for project library detection: ${err instanceof Error ? err.message : String(err)}`);
      return {
        id: hashPath(pkgRoot),
        name: path.basename(pkgRoot),
        path: pkgRoot,
        type: "npm",
      };
    }
  }

  // Priority 3: Return null (use global library)
  // We don't create project libraries for arbitrary directories
  return null;
}

/**
 * Find git repository root by looking for .git directory
 */
function findGitRoot(startPath: string): string | null {
  let currentPath = startPath;
  const root = path.parse(currentPath).root;

  // Bound the upward walk so an attacker-controlled launch dir can't force a
  // deep traversal. (M26)
  for (let depth = 0; depth < MAX_PROJECT_WALK_DEPTH && currentPath !== root; depth++) {
    const gitPath = path.join(currentPath, ".git");
    if (fs.existsSync(gitPath)) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }

  return null;
}

/**
 * Find package.json location by walking up
 */
function findPackageJson(startPath: string): string | null {
  let currentPath = startPath;
  const root = path.parse(currentPath).root;

  // Bound the upward walk so an attacker-controlled launch dir can't force a
  // deep traversal. (M26)
  for (let depth = 0; depth < MAX_PROJECT_WALK_DEPTH && currentPath !== root; depth++) {
    const pkgPath = path.join(currentPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }

  return null;
}

/**
 * Generate a short hash of a path for project ID
 */
function hashPath(filePath: string): string {
  return crypto
    .createHash("sha256")
    .update(filePath)
    .digest("hex")
    .substring(0, 12);
}

/**
 * Synchronous advisory file lock.
 *
 * The library save path is fully synchronous (callers consume the returned
 * NotebookEntry immediately), so the async withLock() in utils/file-lock.ts
 * cannot be used here. This helper mirrors that utility's on-disk convention
 * (a "<file>.lock" sentinel created with the exclusive "wx" flag, JSON body
 * with pid/timestamp, stale-lock reclamation) so the two interoperate safely,
 * but acquires the lock with a blocking spin instead of awaiting. (M25)
 */
const SYNC_LOCK_TIMEOUT_MS = 10000;
const SYNC_LOCK_RETRY_MS = 25;
const SYNC_LOCK_STALE_MS = 900_000;

function withLockSync<T>(filePath: string, operation: () => T): T {
  const lockPath = filePath + ".lock";
  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  }

  const lockBody = JSON.stringify({
    pid: process.pid,
    timestamp: Date.now(),
    hostname: os.hostname(),
  });

  const start = Date.now();
  let acquired = false;
  while (Date.now() - start < SYNC_LOCK_TIMEOUT_MS) {
    try {
      // Reclaim a stale lock left behind by a crashed process.
      if (fs.existsSync(lockPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { timestamp?: number };
          const age = Date.now() - (existing.timestamp ?? 0);
          if (age > SYNC_LOCK_STALE_MS) {
            log.warning(`🔓 Removing stale library lock (age: ${Math.round(age / 1000)}s)`);
            fs.unlinkSync(lockPath);
          }
        } catch {
          // Corrupt lock file — remove it so we can make progress.
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        }
      }

      fs.writeFileSync(lockPath, lockBody, { flag: "wx", mode: 0o600 });
      acquired = true;
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      // Lock held by another process; sleep briefly (no CPU spin) and retry.
      sleepSync(SYNC_LOCK_RETRY_MS);
    }
  }

  if (!acquired) {
    throw new Error(`Could not acquire library lock for ${filePath} within timeout`);
  }

  try {
    return operation();
  } finally {
    try {
      if (fs.existsSync(lockPath)) {
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid?: number };
        if (owner.pid === process.pid) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch (err) {
      log.debug(`notebook-library: releasing library lock: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Deep-clone a Library so that mutations to the copy never alias the original
 * (the previous {...library} shallow copy shared the notebooks array, so a
 * failed write could leave this.library mutated-but-unpersisted). (M25)
 */
function cloneLibrary(library: Library): Library {
  return {
    ...library,
    notebooks: library.notebooks.map((n) => ({
      ...n,
      topics: [...n.topics],
      content_types: [...n.content_types],
      use_cases: [...n.use_cases],
      tags: n.tags ? [...n.tags] : n.tags,
    })),
  };
}

/**
 * Block the current thread for `ms` without busy-spinning a CPU core.
 * Uses Atomics.wait on a throwaway SharedArrayBuffer; the wait always times out
 * (no one ever notifies index 0). Only hit on the contended retry path. (M25)
 */
function sleepSync(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Module-level shutdown registry. (M25)
 *
 * Each NotebookLibrary instance registers itself here; a single set of
 * process listeners (one per signal) flushes every live instance on shutdown.
 * This avoids 3×N process listeners (and the MaxListeners warning) and shrinks
 * the surface that overrides Node's default signal handling. The flush is
 * flush-only — src/index.ts owns the actual SIGINT/SIGTERM exit. (M25)
 */
const LIVE_LIBRARIES = new Set<NotebookLibrary>();
let shutdownHooksInstalled = false;

function flushAllLibraries(): void {
  for (const lib of LIVE_LIBRARIES) {
    try {
      lib.flushSave();
    } catch (err) {
      log.debug(`notebook-library: shutdown flush failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function registerForShutdownFlush(lib: NotebookLibrary): void {
  LIVE_LIBRARIES.add(lib);
  if (!shutdownHooksInstalled) {
    shutdownHooksInstalled = true;
    process.once("SIGTERM", flushAllLibraries);
    process.once("SIGINT", flushAllLibraries);
    process.once("beforeExit", flushAllLibraries);
  }
}

function unregisterFromShutdownFlush(lib: NotebookLibrary): void {
  LIVE_LIBRARIES.delete(lib);
}

export class NotebookLibrary {
  private libraryPath: string;
  private library: Library;
  private projectInfo: ProjectInfo | null;
  private useProjectLibrary: boolean;
  private saveTimer: NodeJS.Timeout | null = null;
  /** Pending use-count deltas keyed by notebook id, flushed by the debounced save. (M25) */
  private pendingUseCounts: Map<string, number> = new Map();

  constructor(options?: { projectId?: string; useProjectLibrary?: boolean }) {
    // Determine if we should use per-project libraries
    this.useProjectLibrary = options?.useProjectLibrary ?? false;

    // Detect or use provided project
    if (options?.projectId) {
      // Use provided project ID (for future use)
      this.projectInfo = null; // Would need lookup
      this.libraryPath = path.join(
        CONFIG.dataDir,
        "projects",
        options.projectId,
        "library.json"
      );
    } else if (this.useProjectLibrary) {
      // Auto-detect project from cwd
      this.projectInfo = detectProject();
      if (this.projectInfo) {
        this.libraryPath = path.join(
          CONFIG.dataDir,
          "projects",
          this.projectInfo.id,
          "library.json"
        );
      } else {
        this.libraryPath = path.join(CONFIG.dataDir, "library.json");
      }
    } else {
      // Use global library
      this.projectInfo = null;
      this.libraryPath = path.join(CONFIG.dataDir, "library.json");
    }

    // Ensure parent directory exists
    const libraryDir = path.dirname(this.libraryPath);
    if (!fs.existsSync(libraryDir)) {
      fs.mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
    }

    this.library = this.loadLibrary();

    // Flush any pending (debounced) use-count updates synchronously on shutdown
    // so they aren't lost when the process exits within the debounce window. (M25)
    registerForShutdownFlush(this);

    log.info("📚 NotebookLibrary initialized");
    log.info(`  Library path: ${this.libraryPath}`);
    log.info(`  Notebooks: ${this.library.notebooks.length}`);
    if (this.projectInfo) {
      log.info(`  Project: ${this.projectInfo.name} (${this.projectInfo.type})`);
    }
    if (this.library.active_notebook_id) {
      log.info(`  Active: ${this.library.active_notebook_id}`);
    }
  }

  /**
   * Get current project info (if using per-project library)
   */
  getProjectInfo(): ProjectInfo | null {
    return this.projectInfo;
  }

  /**
   * Check if using per-project library
   */
  isProjectLibrary(): boolean {
    return this.projectInfo !== null;
  }

  /**
   * Get library file path
   */
  getLibraryPath(): string {
    return this.libraryPath;
  }

  /**
   * Static method to detect project from current directory
   */
  static detectCurrentProject(): ProjectInfo | null {
    return detectProject();
  }

  /**
   * Load library from disk, or create default if not exists
   */
  private loadLibrary(): Library {
    try {
      if (fs.existsSync(this.libraryPath)) {
        const data = fs.readFileSync(this.libraryPath, "utf-8");
        const library = JSON.parse(data) as Library;
        log.success(`  ✅ Loaded library with ${library.notebooks.length} notebooks`);
        return library;
      }
    } catch (error) {
      log.warning(`  ⚠️  Failed to load library: ${error}`);
    }

    // Create default library with current CONFIG as first entry
    log.info("  🆕 Creating new library...");
    const defaultLibrary = this.createDefaultLibrary();
    this.saveLibrary(defaultLibrary);
    return defaultLibrary;
  }

  /**
   * Create default library from current CONFIG
   */
  private createDefaultLibrary(): Library {
    const hasConfig =
      CONFIG.notebookUrl &&
      CONFIG.notebookDescription &&
      CONFIG.notebookDescription !== "General knowledge base - configure NOTEBOOK_DESCRIPTION to help Claude understand what's in this notebook";

    const notebooks: NotebookEntry[] = [];

    if (hasConfig) {
      // Create first entry from CONFIG
      const id = this.generateId(CONFIG.notebookDescription);
      notebooks.push({
        id,
        url: CONFIG.notebookUrl,
        name: CONFIG.notebookDescription.substring(0, 50), // First 50 chars as name
        description: CONFIG.notebookDescription,
        topics: CONFIG.notebookTopics,
        content_types: CONFIG.notebookContentTypes,
        use_cases: CONFIG.notebookUseCases,
        added_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 0,
        tags: [],
      });

      log.success(`  ✅ Created default notebook: ${id}`);
    }

    return {
      notebooks,
      active_notebook_id: notebooks.length > 0 ? notebooks[0].id : null,
      last_modified: new Date().toISOString(),
      version: "1.0.0",
    };
  }

  /**
   * Save library to disk
   */
  private saveLibrary(library: Library): void {
    try {
      library.last_modified = new Date().toISOString();
      const data = JSON.stringify(library, null, 2);
      writeFileSecure(this.libraryPath, data, PERMISSION_MODES.OWNER_READ_WRITE);
      this.library = library;
      log.success(`  💾 Library saved (${library.notebooks.length} notebooks)`);
    } catch (error) {
      log.error(`  ❌ Failed to save library: ${error}`);
      throw error;
    }
  }

  /**
   * Read the library file from disk without mutating in-memory state.
   * Used inside the lock to pick up changes made by concurrent sessions. (M25)
   */
  private readLibraryFromDisk(): Library {
    try {
      if (fs.existsSync(this.libraryPath)) {
        const data = fs.readFileSync(this.libraryPath, "utf-8");
        return JSON.parse(data) as Library;
      }
    } catch (error) {
      log.warning(`  ⚠️  Failed to reload library from disk: ${error}`);
    }
    // Fall back to a deep copy of the in-memory library if the file is gone.
    return cloneLibrary(this.library);
  }

  /**
   * Atomically apply a read-modify-write to the library file.
   *
   * Holds a cross-process lock, reloads the latest library from disk (so a
   * concurrent session's notebooks aren't clobbered), applies `mutate` to a
   * deep copy, persists it, and only then commits it to this.library. If the
   * write throws, this.library is left untouched. (M25)
   */
  private mutateLibrary<T>(mutate: (library: Library) => T): T {
    return withLockSync(this.libraryPath, () => {
      const working = cloneLibrary(this.readLibraryFromDisk());
      const result = mutate(working);
      this.saveLibrary(working);
      return result;
    });
  }

  /**
   * Generate a unique ID from a string (slug format).
   * Uniqueness is checked against the supplied library (defaults to the
   * in-memory one) so callers inside mutateLibrary can de-dupe against the
   * freshly-reloaded disk state. (M25)
   */
  private generateId(name: string, library: Library = this.library): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 30);

    // Ensure uniqueness
    let id = base;
    let counter = 1;
    while (library.notebooks.some((n) => n.id === id)) {
      id = `${base}-${counter}`;
      counter++;
    }

    return id;
  }

  /**
   * Add a new notebook to the library
   */
  addNotebook(input: AddNotebookInput): NotebookEntry {
    log.info(`📝 Adding notebook: ${input.name}`);

    // Locked read-modify-write against the latest on-disk library so a
    // concurrent session's notebooks are preserved. (M25)
    return this.mutateLibrary((library) => {
      // Generate ID unique within the freshly-reloaded library.
      const id = this.generateId(input.name, library);

      // Create entry
      const notebook: NotebookEntry = {
        id,
        url: input.url,
        name: input.name,
        description: input.description,
        topics: input.topics,
        content_types: input.content_types || ["documentation", "examples"],
        use_cases: input.use_cases || [
          `Learning about ${input.name}`,
          `Implementing features with ${input.name}`,
        ],
        added_at: new Date().toISOString(),
        last_used: new Date().toISOString(),
        use_count: 0,
        tags: input.tags || [],
      };

      library.notebooks.push(notebook);

      // Set as active if it's the first notebook
      if (library.notebooks.length === 1) {
        library.active_notebook_id = id;
      }

      log.success(`✅ Notebook added: ${id}`);
      return notebook;
    });
  }

  /**
   * List all notebooks in library
   */
  listNotebooks(): NotebookEntry[] {
    return this.library.notebooks;
  }

  /**
   * Get a specific notebook by ID
   */
  getNotebook(id: string): NotebookEntry | null {
    return this.library.notebooks.find((n) => n.id === id) || null;
  }

  /**
   * Get the currently active notebook
   */
  getActiveNotebook(): NotebookEntry | null {
    if (!this.library.active_notebook_id) {
      return null;
    }
    return this.getNotebook(this.library.active_notebook_id);
  }

  /**
   * Select a notebook as active
   */
  selectNotebook(id: string): NotebookEntry {
    log.info(`🎯 Selecting notebook: ${id}`);

    // Locked read-modify-write against the latest on-disk library. (M25)
    return this.mutateLibrary((library) => {
      const notebookIndex = library.notebooks.findIndex((n) => n.id === id);
      if (notebookIndex === -1) {
        throw new Error(`Notebook not found: ${id}`);
      }

      library.active_notebook_id = id;
      library.notebooks[notebookIndex] = {
        ...library.notebooks[notebookIndex],
        last_used: new Date().toISOString(),
      };

      log.success(`✅ Active notebook: ${id}`);
      return library.notebooks[notebookIndex];
    });
  }

  /**
   * Update notebook metadata
   */
  updateNotebook(input: UpdateNotebookInput): NotebookEntry {
    log.info(`📝 Updating notebook: ${input.id}`);

    // Locked read-modify-write against the latest on-disk library. (M25)
    return this.mutateLibrary((library) => {
      const index = library.notebooks.findIndex((n) => n.id === input.id);
      if (index === -1) {
        throw new Error(`Notebook not found: ${input.id}`);
      }

      library.notebooks[index] = {
        ...library.notebooks[index],
        ...(input.name && { name: input.name }),
        ...(input.description && { description: input.description }),
        ...(input.topics && { topics: input.topics }),
        ...(input.content_types && { content_types: input.content_types }),
        ...(input.use_cases && { use_cases: input.use_cases }),
        ...(input.tags && { tags: input.tags }),
        ...(input.url && { url: input.url }),
      };

      log.success(`✅ Notebook updated: ${input.id}`);
      return library.notebooks[index];
    });
  }

  /**
   * Remove notebook from library
   */
  removeNotebook(id: string): boolean {
    log.info(`🗑️  Removing notebook: ${id}`);

    // Locked read-modify-write against the latest on-disk library. (M25)
    return this.mutateLibrary((library) => {
      const exists = library.notebooks.some((n) => n.id === id);
      if (!exists) {
        return false;
      }

      library.notebooks = library.notebooks.filter((n) => n.id !== id);

      // If we removed the active notebook, select another one
      if (library.active_notebook_id === id) {
        library.active_notebook_id =
          library.notebooks.length > 0 ? library.notebooks[0].id : null;
      }

      log.success(`✅ Notebook removed: ${id}`);
      return true;
    });
  }

  /**
   * Increment use count for a notebook
   */
  incrementUseCount(id: string): NotebookEntry | null {
    const notebookIndex = this.library.notebooks.findIndex((n) => n.id === id);
    if (notebookIndex === -1) {
      return null;
    }

    const notebook = this.library.notebooks[notebookIndex];
    const updatedNotebook: NotebookEntry = {
      ...notebook,
      use_count: notebook.use_count + 1,
      last_used: new Date().toISOString(),
    };

    this.library.notebooks[notebookIndex] = updatedNotebook;
    // Track the delta so the debounced flush can re-apply it additively to the
    // latest on-disk state instead of clobbering concurrent sessions. (M25)
    this.pendingUseCounts.set(id, (this.pendingUseCounts.get(id) ?? 0) + 1);
    this.debouncedSave();

    return updatedNotebook;
  }

  /**
   * Debounced save — avoids writing to disk on every single query
   */
  private debouncedSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, 5000);
    this.saveTimer.unref();
  }

  /**
   * Synchronously flush any pending debounced use-count updates to disk under
   * the cross-process lock, re-applying the accumulated deltas to the latest
   * on-disk library so concurrent sessions' notebooks and counts survive. (M25)
   */
  flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.pendingUseCounts.size === 0) {
      return;
    }

    const deltas = new Map(this.pendingUseCounts);
    this.pendingUseCounts.clear();

    try {
      this.mutateLibrary((library) => {
        const now = new Date().toISOString();
        for (const [id, delta] of deltas) {
          const idx = library.notebooks.findIndex((n) => n.id === id);
          if (idx === -1) continue;
          library.notebooks[idx] = {
            ...library.notebooks[idx],
            use_count: library.notebooks[idx].use_count + delta,
            last_used: now,
          };
        }
      });
    } catch (error) {
      // Restore the deltas so a later flush can retry rather than lose them. (M25)
      for (const [id, delta] of deltas) {
        this.pendingUseCounts.set(id, (this.pendingUseCounts.get(id) ?? 0) + delta);
      }
      log.error(`  ❌ Failed to flush library use-count updates: ${error}`);
    }
  }

  /**
   * Release resources: flush pending writes and detach shutdown handlers. (M25)
   */
  close(): void {
    this.flushSave();
    unregisterFromShutdownFlush(this);
  }

  /**
   * Get library statistics
   */
  getStats(): LibraryStats {
    const totalQueries = this.library.notebooks.reduce(
      (sum, n) => sum + n.use_count,
      0
    );

    const mostUsed = this.library.notebooks.reduce((max, n) =>
      n.use_count > (max?.use_count || 0) ? n : max
    , null as NotebookEntry | null);

    return {
      total_notebooks: this.library.notebooks.length,
      active_notebook: this.library.active_notebook_id,
      most_used_notebook: mostUsed?.id || null,
      total_queries: totalQueries,
      last_modified: this.library.last_modified,
    };
  }

  /**
   * Search notebooks by query (searches name, description, topics)
   */
  searchNotebooks(query: string): NotebookEntry[] {
    const lowerQuery = query.toLowerCase();
    return this.library.notebooks.filter(
      (n) =>
        n.name.toLowerCase().includes(lowerQuery) ||
        n.description.toLowerCase().includes(lowerQuery) ||
        n.topics.some((t) => t.toLowerCase().includes(lowerQuery)) ||
        n.tags?.some((t) => t.toLowerCase().includes(lowerQuery))
    );
  }
}
