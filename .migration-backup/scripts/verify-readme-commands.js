const fs = require("fs");
const path = require("path");

const root = process.cwd();

function readFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(`${message}: missing "${needle}"`);
  }
}

function assertPackageScript(packageJsonPath, scriptName) {
  const pkg = JSON.parse(readFile(packageJsonPath));

  if (!pkg.scripts || !pkg.scripts[scriptName]) {
    throw new Error(`${packageJsonPath} is missing the "${scriptName}" script`);
  }
}

function main() {
  const readme = readFile("README.md");
  const cargoToml = readFile("contracts/Cargo.toml");

  const expectedReadmeCommands = [
    "cd client",
    "npm ci",
    "npm run dev",
    "npm run lint",
    "npm run build",
    "npm run test",
    "cd server",
    "npm test",
    "cd contracts",
    "cargo fmt --all -- --check",
    "cargo clippy --workspace --all-targets -- -D warnings",
    "cargo test --workspace",
    "node scripts/verify-readme-commands.js",
  ];

  for (const command of expectedReadmeCommands) {
    assertIncludes(readme, command, "README command check failed");
  }

  assertPackageScript("client/package.json", "dev");
  assertPackageScript("client/package.json", "lint");
  assertPackageScript("client/package.json", "build");
  assertPackageScript("client/package.json", "test");
  assertPackageScript("server/package.json", "dev");
  assertPackageScript("server/package.json", "lint");
  assertPackageScript("server/package.json", "build");
  assertPackageScript("server/package.json", "test");

  assertIncludes(cargoToml, "[workspace]", "contracts/Cargo.toml workspace check failed");
  assertIncludes(readme, "./docs/contributor-guide.md", "README docs link check failed");
  assertIncludes(readme, "./docs/release-checklist.md", "README docs link check failed");

  console.log("README command verification passed.");
}

main();
