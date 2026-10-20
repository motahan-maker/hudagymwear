// scripts/printify-verify.mjs
//
// Launcher for the read-only Printify verification tool.
//
// The tool itself is TypeScript, because it shares the HTTP client and the
// response parsers with the Edge Function and the test suite. Node can run
// TypeScript directly from 22.18 onwards (type stripping, no transform
// step), so this launcher checks the version first and explains itself
// rather than failing with a syntax error.
//
// Usage:
//   node scripts/printify-verify.mjs shops
//   node scripts/printify-verify.mjs audit

const [major, minor] = process.versions.node.split(".").map(Number);
const supportsTypeStripping = major > 22 || (major === 22 && minor >= 18);

if (!supportsTypeStripping) {
  console.error(
    `This tool needs Node 22.18 or newer to run its TypeScript source (this is ${process.versions.node}).\n` +
      "It only READS from the Printify API — nothing is written anywhere.\n" +
      "The app itself runs on the Node version in package.json; only this developer tool needs the newer one.",
  );
  process.exit(2);
}

await import("./printify-verify.ts");
