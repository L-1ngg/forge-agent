import * as fs from "node:fs/promises";

export type MemoryFileSystem = Pick<typeof fs, "open" | "mkdir" | "lstat" | "realpath" | "readdir" | "unlink" | "readFile" | "writeFile" | "copyFile">;
export const memoryFiles: MemoryFileSystem = fs;
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";
