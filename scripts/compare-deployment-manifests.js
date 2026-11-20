#!/usr/bin/env node
"use strict";
const fs = require("fs");
function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index].startsWith("--") && index + 1 < argv.length) {
      args[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
}
function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { console.error("ERROR: unable to read JSON from " + filePath + ": " + error.message); process.exit(1); }
}
function flatten(value, prefix, output) {
  prefix = prefix || ""; output = output || new Map();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    Object.keys(value).sort().forEach(function (key) { flatten(value[key], prefix ? prefix + "." + key : key, output); });
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(function (item, index) { flatten(item, prefix + "[" + index + "]", output); });
    return output;
  }
  output.set(prefix, value); return output;
}
function formatValue(value) { return value === undefined ? "<missing>" : JSON.stringify(value); }
const args = parseArgs(process.argv);
if (!args.base || !args.head) { console.error("Usage: node scripts/compare-deployment-manifests.js --base <file> --head <file>"); process.exit(1); }
const base = readJson(args.base), head = readJson(args.head);
const baseValues = flatten(base), headValues = flatten(head);
const paths = Array.from(new Set(Array.from(baseValues.keys()).concat(Array.from(headValues.keys())))).sort();
const changes = paths.filter(function (path) { return JSON.stringify(baseValues.get(path)) !== JSON.stringify(headValues.get(path)); }).map(function (path) { return { path: path, base: baseValues.get(path), head: headValues.get(path) }; });
console.log("Deployment manifest diff: " + args.base + " -> " + args.head);
if (changes.length === 0) { console.log("No differences found."); process.exit(0); }
changes.forEach(function (change) {
  const kind = change.base === undefined ? "ADDED" : change.head === undefined ? "REMOVED" : "CHANGED";
  console.log(kind.padEnd(8) + " " + change.path + ": " + formatValue(change.base) + " -> " + formatValue(change.head));
});
console.log(changes.length + " difference(s) found.");
