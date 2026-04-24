/**
 * Types for notebook creation functionality
 */

import type { ProgressCallback } from "../types.js";

/**
 * Source types supported for notebook creation
 */
export type SourceType = "url" | "text" | "file";

/**
 * A source to add to a notebook
 */
export interface NotebookSource {
  /** Type of source */
  type: SourceType;
  /** URL, text content, or file path depending on type */
  value: string;
  /** Optional title for text sources */
  title?: string;
}

/**
 * Options for creating a notebook
 */
export interface CreateNotebookOptions {
  /** Display name for the notebook */
  name: string;
  /** Sources to add to the notebook */
  sources: NotebookSource[];
  /** Progress callback for status updates */
  sendProgress?: ProgressCallback;
  /** Browser options override */
  browserOptions?: {
    headless?: boolean;
    show?: boolean;
    timeout_ms?: number;
  };
}

/**
 * Result of notebook creation
 */
export interface CreatedNotebook {
  /** URL of the created notebook */
  url: string;
  /** Name of the notebook */
  name: string;
  /** Number of sources successfully added */
  sourceCount: number;
  /** ISO timestamp of creation */
  createdAt: string;
  /** Any sources that failed to add */
  failedSources?: FailedSource[];
  /** True when notebook creation succeeded but one or more sources failed */
  partial?: boolean;
}

/**
 * Information about a failed source
 */
export interface FailedSource {
  /** The source that failed */
  source: NotebookSource;
  /** Error message */
  error: string;
  /** Stack trace included only when DEBUG=true */
  stack?: string;
}

/**
 * Input for create_notebook tool
 */
export interface CreateNotebookInput {
  /** Display name for the notebook */
  name: string;
  /** Sources to add */
  sources: NotebookSource[];
  /** Optional description for library */
  description?: string;
  /** Optional topics for library */
  topics?: string[];
  /** Whether to auto-add to library (default: true) */
  auto_add_to_library?: boolean;
  /** Browser options */
  browser_options?: {
    headless?: boolean;
    show?: boolean;
    timeout_ms?: number;
  };
  /** Show browser window (simple version) */
  show_browser?: boolean;
}

/**
 * Discovered UI element information
 */
export interface ElementInfo {
  /** HTML tag name */
  tag: string;
  /** Element ID if present */
  id: string;
  /** CSS classes */
  classes: string;
  /** aria-label attribute */
  ariaLabel: string | null;
  /** Text content (truncated) */
  text: string | null;
  /** data-* attributes */
  dataAttrs: Record<string, string>;
  /** Element's role attribute */
  role: string | null;
  /** Whether element is visible */
  isVisible: boolean;
  /** Bounding box if visible */
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * Discovered selectors for NotebookLM UI
 */
export interface DiscoveredSelectors {
  /** Selector for "New notebook" button on homepage */
  newNotebookButton: SelectorInfo;
  /** Selector for notebook name input */
  notebookNameInput: SelectorInfo;
  /** Selector for "Add source" button */
  addSourceButton: SelectorInfo;
  /** Selector for URL source option */
  urlSourceOption: SelectorInfo;
  /** Selector for text source option */
  textSourceOption: SelectorInfo;
  /** Selector for file source option */
  fileSourceOption: SelectorInfo;
  /** Selector for URL input field */
  urlInput: SelectorInfo;
  /** Selector for text input area */
  textInput: SelectorInfo;
  /** Selector for file input element */
  fileInput: SelectorInfo;
  /** Selector for submit/add button */
  submitButton: SelectorInfo;
  /** Selector for processing indicator */
  processingIndicator: SelectorInfo;
  /** Selector for success indicator */
  successIndicator: SelectorInfo;
  /** Selector for error message */
  errorMessage: SelectorInfo;
}

/**
 * Information about a discovered selector
 */
export interface SelectorInfo {
  /** Primary CSS selector */
  primary: string;
  /** Fallback selectors in priority order */
  fallbacks: string[];
  /** Description of what this selector targets */
  description: string;
  /** Whether this selector was confirmed working */
  confirmed: boolean;
}

/**
 * Result of selector discovery
 */
export interface DiscoveryResult {
  /** Discovered selectors */
  selectors: Partial<DiscoveredSelectors>;
  /** Elements found on homepage */
  homepageElements: ElementInfo[];
  /** Elements found on creation page/modal */
  creationElements: ElementInfo[];
  /** Elements found on source addition UI */
  sourceElements: ElementInfo[];
  /** Discovery timestamp */
  discoveredAt: string;
  /** Any errors encountered */
  errors: string[];
}
