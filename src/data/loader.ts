import { SecureHttpClient } from "../http/client.js";
import { resolve, isAbsolute, dirname } from "path";
import { readFile, stat } from "fs/promises";

/**
 * Unified data loader that supports both remote URLs (HTTP/HTTPS) and local file paths.
 * Designed for npx execution context where paths are resolved relative to user's CWD.
 */
export class UnifiedDataLoader {
  private httpClient: SecureHttpClient;

  constructor(httpClient?: SecureHttpClient) {
    this.httpClient = httpClient || new SecureHttpClient();
  }

  /**
   * Fetch data from either a remote URL or local file path
   */
  async fetch(location: string): Promise<Response> {
    if (this.isLocalPath(location)) {
      return this.fetchLocalFile(location);
    }
    return this.httpClient.fetch(location);
  }

  /**
   * Determine if the location string is a local file path vs remote URL
   */
  private isLocalPath(location: string): boolean {
    // file:// protocol
    if (location.startsWith("file://")) return true;

    // Relative paths (./  ../)
    if (location.startsWith("./") || location.startsWith("../")) return true;

    // Absolute filesystem paths (Unix)
    if (location.startsWith("/")) return true;

    // Windows absolute paths (C:\ or C:/)
    if (/^[A-Za-z]:[\\/]/.test(location)) return true;

    // Try URL parsing - if it fails, it's likely a file path
    try {
      const url = new URL(location);
      // If it has file: protocol, it's a file
      return url.protocol === "file:";
    } catch {
      // Not a valid URL, treat as file path
      return true;
    }
  }

  /**
   * Fetch data from local filesystem
   */
  private async fetchLocalFile(location: string): Promise<Response> {
    try {
      // Resolve path
      let filePath = location.replace(/^file:\/\//, "");

      // Resolve relative to CWD (user's project directory for npx)
      if (!isAbsolute(filePath)) {
        filePath = resolve(process.cwd(), filePath);
      }

      // Normalize to prevent traversal
      filePath = resolve(filePath);

      console.error(`[Data Loader] Reading local file: ${filePath}`);

      // Check file exists and is readable
      const stats = await stat(filePath);

      if (!stats.isFile()) {
        throw new FileAccessError(
          `Path is not a file: ${location}`,
          `Resolved path: ${filePath}`,
          "NOT_A_FILE"
        );
      }

      // Optional: size limit (10MB default)
      const maxSize = parseInt(
        process.env.STORYBOOK_MAX_FILE_SIZE || "10485760"
      );
      if (stats.size > maxSize) {
        throw new FileAccessError(
          `File too large: ${stats.size} bytes (max: ${maxSize})`,
          `File: ${filePath}`,
          "FILE_TOO_LARGE"
        );
      }

      // Read file
      const content = await readFile(filePath, "utf8");

      // Validate JSON
      let jsonData;
      try {
        jsonData = JSON.parse(content);
      } catch (parseError) {
        throw new FileAccessError(
          `Invalid JSON in file: ${
            parseError instanceof Error ? parseError.message : String(parseError)
          }`,
          `File: ${filePath}`,
          "INVALID_JSON"
        );
      }

      console.error(
        `[Data Loader] Successfully loaded file: ${stats.size} bytes`
      );

      // Return Response-like object compatible with existing code
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => jsonData,
        text: async () => content,
      } as Response;
    } catch (error) {
      // Format user-friendly error messages for CLI context
      this.formatAndThrowError(error, location);
    }
  }

  /**
   * Get base URL/path for constructing iframe URLs
   * For local files, returns the directory containing the file as file:// URL
   */
  getBaseUrl(location: string): string {
    if (this.isLocalPath(location)) {
      let filePath = location.replace(/^file:\/\//, "");

      if (!isAbsolute(filePath)) {
        filePath = resolve(process.cwd(), filePath);
      }

      const dirPath = dirname(resolve(filePath));
      return `file://${dirPath}`;
    }

    const url = new URL(location);
    return `${url.protocol}//${url.host}`;
  }

  /**
   * Format error messages for CLI/npx execution context
   */
  private formatAndThrowError(error: any, location: string): never {
    if (error instanceof FileAccessError) {
      throw error;
    }

    if (error.code === "ENOENT") {
      console.error(`\n❌ File not found: ${location}`);
      console.error(`   Current directory: ${process.cwd()}`);
      console.error(
        `   Make sure the path is correct relative to your current location.\n`
      );
      throw new FileAccessError(
        `File not found: ${location}`,
        `CWD: ${process.cwd()}`,
        "ENOENT"
      );
    }

    if (error.code === "EACCES") {
      console.error(`\n❌ Permission denied: ${location}`);
      console.error(`   The file exists but cannot be read.`);
      console.error(`   Check file permissions.\n`);
      throw new FileAccessError(
        `Permission denied: ${location}`,
        undefined,
        "EACCES"
      );
    }

    // Generic error
    throw new FileAccessError(
      `Failed to read file: ${
        error instanceof Error ? error.message : String(error)
      }`,
      `Location: ${location}`,
      "UNKNOWN"
    );
  }
}

/**
 * Custom error class for file access issues
 */
export class FileAccessError extends Error {
  constructor(
    public userMessage: string,
    public debugInfo?: string,
    public code?: string
  ) {
    super(userMessage);
    this.name = "FileAccessError";
  }
}
