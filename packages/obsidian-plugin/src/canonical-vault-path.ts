export function isCanonicalVaultPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.includes("//") &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}
