export function isCanonicalVaultPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("//") &&
    !path.split("/").some((part) => part === "." || part === "..")
  );
}
