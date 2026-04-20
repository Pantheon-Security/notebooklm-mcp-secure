export enum NotebookCreationErrorCode {
  PAGE_NOT_INITIALIZED = "PAGE_NOT_INITIALIZED",
  CLICK_NEW_NOTEBOOK_FAILED = "CLICK_NEW_NOTEBOOK_FAILED",
}

export interface NotebookCreationErrorOptions {
  code: NotebookCreationErrorCode;
  selector?: string;
  url?: string;
  cause?: unknown;
}

export class NotebookCreationError extends Error {
  readonly code: NotebookCreationErrorCode;
  readonly selector?: string;
  readonly url?: string;
  override readonly cause?: unknown;

  constructor(message: string, options: NotebookCreationErrorOptions) {
    super(message);
    this.name = "NotebookCreationError";
    this.code = options.code;
    this.selector = options.selector;
    this.url = options.url;
    this.cause = options.cause;
  }
}
