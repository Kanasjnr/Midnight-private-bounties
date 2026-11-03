// Bundles entry.js for the browser, minified, and reports raw and gzip sizes.
//   node bundle.mjs
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
const out = await build({ entryPoints: ["entry.js"], bundle: true, minify: true, format: "esm", platform: "browser", write: false });
const code = out.outputFiles[0].contents;
console.log(JSON.stringify({ bytes: code.length, gzip: gzipSync(code).length }));
