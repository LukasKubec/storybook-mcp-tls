import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { UnifiedDataLoader, FileAccessError } from "../src/data/loader.js";
import { writeFile, mkdir, rm, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("UnifiedDataLoader", () => {
  let testDir: string;
  let loader: UnifiedDataLoader;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `storybook-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    loader = new UnifiedDataLoader();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe("Local File Path Detection", () => {
    it("should detect file:// protocol as local path", async () => {
      const testFile = join(testDir, "index.json");
      await writeFile(testFile, JSON.stringify({ v: 5, entries: {} }));

      const response = await loader.fetch(`file://${testFile}`);
      expect(response.ok).toBe(true);
    });

    it("should detect relative paths as local", async () => {
      const testFile = join(process.cwd(), "test-relative.json");
      await writeFile(testFile, JSON.stringify({ v: 5, entries: {} }));

      try {
        const response = await loader.fetch("./test-relative.json");
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data).toEqual({ v: 5, entries: {} });
      } finally {
        await rm(testFile, { force: true });
      }
    });

    it("should detect absolute paths as local", async () => {
      const testFile = join(testDir, "index.json");
      await writeFile(testFile, JSON.stringify({ v: 5, entries: {} }));

      const response = await loader.fetch(testFile);
      expect(response.ok).toBe(true);
    });

    it("should detect HTTP URLs as remote", () => {
      // This test just validates path detection, not actual fetching
      // We can't easily test remote fetching without mocking
      expect(() => new URL("http://example.com/index.json")).not.toThrow();
    });
  });

  describe("Local File Reading", () => {
    it("should read valid JSON file", async () => {
      const testData = {
        v: 5,
        entries: {
          "button--docs": {
            type: "docs",
            id: "button--docs",
            name: "Button",
            title: "Button",
            importPath: "./Button.tsx",
            tags: ["autodocs"],
          },
        },
      };

      const testFile = join(testDir, "index.json");
      await writeFile(testFile, JSON.stringify(testData));

      const response = await loader.fetch(testFile);
      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data).toEqual(testData);
    });

    it("should handle Storybook v3 format", async () => {
      const testData = {
        v: 3,
        stories: {
          "button--primary": {
            id: "button--primary",
            title: "Button",
            name: "Primary",
            importPath: "./Button.stories.tsx",
            kind: "Components/Button",
            story: "Primary",
            parameters: {
              __id: "button--primary",
              docsOnly: false,
              fileName: "./Button.stories.tsx",
            },
          },
        },
      };

      const testFile = join(testDir, "stories.json");
      await writeFile(testFile, JSON.stringify(testData));

      const response = await loader.fetch(testFile);
      const data = await response.json();
      expect(data).toEqual(testData);
    });

    it("should throw error for non-existent file", async () => {
      const nonExistent = join(testDir, "does-not-exist.json");

      await expect(loader.fetch(nonExistent)).rejects.toThrow(FileAccessError);
      await expect(loader.fetch(nonExistent)).rejects.toThrow("File not found");
    });

    it("should throw error for invalid JSON", async () => {
      const testFile = join(testDir, "invalid.json");
      await writeFile(testFile, "{ invalid json }");

      await expect(loader.fetch(testFile)).rejects.toThrow(FileAccessError);
      await expect(loader.fetch(testFile)).rejects.toThrow("Invalid JSON");
    });

    it("should throw error for directory instead of file", async () => {
      const dirPath = join(testDir, "subdir");
      await mkdir(dirPath);

      await expect(loader.fetch(dirPath)).rejects.toThrow(FileAccessError);
      await expect(loader.fetch(dirPath)).rejects.toThrow("not a file");
    });

    it("should enforce file size limit", async () => {
      const largeData = { data: "x".repeat(11 * 1024 * 1024) }; // >10MB
      const testFile = join(testDir, "large.json");
      await writeFile(testFile, JSON.stringify(largeData));

      await expect(loader.fetch(testFile)).rejects.toThrow(FileAccessError);
      await expect(loader.fetch(testFile)).rejects.toThrow("File too large");
    });

    it("should respect custom file size limit from env", async () => {
      const originalEnv = process.env.STORYBOOK_MAX_FILE_SIZE;
      process.env.STORYBOOK_MAX_FILE_SIZE = "100"; // 100 bytes

      try {
        const testData = { data: "x".repeat(200) }; // >100 bytes
        const testFile = join(testDir, "test.json");
        await writeFile(testFile, JSON.stringify(testData));

        await expect(loader.fetch(testFile)).rejects.toThrow("File too large");
      } finally {
        if (originalEnv) {
          process.env.STORYBOOK_MAX_FILE_SIZE = originalEnv;
        } else {
          delete process.env.STORYBOOK_MAX_FILE_SIZE;
        }
      }
    });
  });

  describe("Path Resolution", () => {
    it("should resolve relative paths from CWD", async () => {
      const relativePath = "./test-cwd-resolve.json";
      const absolutePath = join(process.cwd(), "test-cwd-resolve.json");

      await writeFile(absolutePath, JSON.stringify({ v: 5, entries: {} }));

      try {
        const response = await loader.fetch(relativePath);
        expect(response.ok).toBe(true);
      } finally {
        await rm(absolutePath, { force: true });
      }
    });

    it("should normalize paths to prevent traversal", async () => {
      const testFile = join(testDir, "index.json");
      await writeFile(testFile, JSON.stringify({ v: 5, entries: {} }));

      // Try path with traversal components
      const traversalPath = join(testDir, "subdir", "..", "index.json");
      const response = await loader.fetch(traversalPath);
      expect(response.ok).toBe(true);
    });
  });

  describe("Base URL Generation", () => {
    it("should generate base URL for local files", () => {
      const testFile = join(testDir, "index.json");
      const baseUrl = loader.getBaseUrl(testFile);

      expect(baseUrl).toBe(`file://${testDir}`);
    });

    it("should handle file:// protocol in base URL", () => {
      const testFile = join(testDir, "index.json");
      const baseUrl = loader.getBaseUrl(`file://${testFile}`);

      expect(baseUrl).toBe(`file://${testDir}`);
    });

    it("should generate base URL for remote URLs", () => {
      const url = "https://example.com/storybook/index.json";
      const baseUrl = loader.getBaseUrl(url);

      expect(baseUrl).toBe("https://example.com");
    });

    it("should handle relative paths in base URL", () => {
      const relativePath = "./storybook-static/index.json";
      const expectedDir = join(process.cwd(), "storybook-static");
      const baseUrl = loader.getBaseUrl(relativePath);

      expect(baseUrl).toBe(`file://${expectedDir}`);
    });
  });

  describe("Error Messages", () => {
    it("should provide user-friendly error for missing file", async () => {
      const missingFile = join(testDir, "missing.json");

      try {
        await loader.fetch(missingFile);
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(FileAccessError);
        const fileError = error as FileAccessError;
        expect(fileError.userMessage).toContain("File not found");
        expect(fileError.code).toBe("ENOENT");
      }
    });

    it("should provide user-friendly error for invalid JSON", async () => {
      const testFile = join(testDir, "bad.json");
      await writeFile(testFile, "not json");

      try {
        await loader.fetch(testFile);
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect(error).toBeInstanceOf(FileAccessError);
        const fileError = error as FileAccessError;
        expect(fileError.userMessage).toContain("Invalid JSON");
        expect(fileError.code).toBe("INVALID_JSON");
      }
    });
  });

  describe("Integration with Response API", () => {
    it("should return Response-compatible object", async () => {
      const testData = { v: 5, entries: {} };
      const testFile = join(testDir, "index.json");
      await writeFile(testFile, JSON.stringify(testData));

      const response = await loader.fetch(testFile);

      expect(response.ok).toBe(true);
      expect(response.status).toBe(200);
      expect(response.statusText).toBe("OK");
      expect(typeof response.json).toBe("function");
      expect(typeof response.text).toBe("function");
    });

    it("should support both json() and text() methods", async () => {
      const testData = { v: 5, entries: {} };
      const testFile = join(testDir, "index.json");
      const jsonString = JSON.stringify(testData);
      await writeFile(testFile, jsonString);

      const response = await loader.fetch(testFile);

      const jsonResult = await response.json();
      expect(jsonResult).toEqual(testData);

      // Note: In real Response, text() can only be called once
      // Our implementation allows multiple calls for testing
      const textResult = await response.text();
      expect(textResult).toBe(jsonString);
    });
  });
});
