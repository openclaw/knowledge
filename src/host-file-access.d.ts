// The verified gateway build exports this supported runtime subpath but omits
// its .d.ts. This narrow declaration mirrors the inspected SDK Root subset;
// runtime tests exercise the actual implementation, not a replacement reader.
declare module "openclaw/plugin-sdk/file-access-runtime" {
  export function root(path: string, options?: {
    maxBytes?: number; symlinks?: "reject"; hardlinks?: "reject"; nonBlockingRead?: boolean;
  }): Promise<{
    read(path: string): Promise<{ buffer: Uint8Array }>;
    entries(path: string, options?: { maxEntries?: number; order?: "sorted"; symlinks?: "reject" }): AsyncIterableIterator<{
      name: string; isSymbolicLink: boolean; isDirectory: boolean; isFile: boolean;
    }>;
  }>;
}
