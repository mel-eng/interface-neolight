import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const errors = [];
const warnings = [];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const files = walk(root).filter(file => !file.includes(`${path.sep}node_modules${path.sep}`));
const javascriptFiles = files.filter(file => file.endsWith(".js") || file.endsWith(".mjs"));
for (const file of javascriptFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) errors.push(`Sintaxis JS: ${path.relative(root, file)}\n${result.stderr.trim()}`);
}

const htmlFiles = files.filter(file => file.startsWith(publicDir) && file.endsWith(".html"));
const htmlDocuments = htmlFiles.map(file => ({ file, html: fs.readFileSync(file, "utf8") }));
const idLocations = new Map();
for (const { file, html } of htmlDocuments) {
  for (const match of html.matchAll(/\bid=["']([^"']+)["']/g)) {
    const id = match[1];
    if (!idLocations.has(id)) idLocations.set(id, []);
    idLocations.get(id).push(path.relative(root, file));
  }
}
const duplicateIds = [...idLocations.entries()].filter(([, locations]) => locations.length > 1);
if (duplicateIds.length) {
  errors.push(`IDs HTML duplicados: ${duplicateIds.map(([id, locations]) => `${id} (${locations.join(", ")})`).join("; ")}`);
}
const ids = [...idLocations.keys()];

for (const { file, html } of htmlDocuments) {
  for (const match of html.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)) {
    const reference = match[1];
    if (/^(?:https?:|data:|\/socket\.io\/)/.test(reference)) continue;
    const localResolved = path.resolve(path.dirname(file), reference);
    const documentResolved = path.resolve(publicDir, reference);
    if (!fs.existsSync(localResolved) && !fs.existsSync(documentResolved))
      errors.push(`Referencia HTML inexistente en ${path.relative(root, file)}: ${reference}`);
  }
}

const cssManifest = path.join(publicDir, "css", "styles.css");
const css = fs.readFileSync(cssManifest, "utf8");
for (const match of css.matchAll(/@import\s+url\(["']?([^"')]+)["']?\)/g)) {
  const resolved = path.resolve(path.dirname(cssManifest), match[1]);
  if (!fs.existsSync(resolved)) errors.push(`Módulo CSS inexistente: ${match[1]}`);
}

for (const file of files.filter(file => file.startsWith(publicDir) && /\.(?:js|css|html)$/.test(file))) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).length;
  if (lines > 1000) warnings.push(`${path.relative(root, file)} tiene ${lines} líneas.`);
}

for (const forbidden of ["node_modules", ".git", "reportes"]) {
  if (fs.existsSync(path.join(root, forbidden))) warnings.push(`La carpeta ${forbidden}/ no debe incluirse en el ZIP limpio.`);
}

if (warnings.length) {
  console.log("ADVERTENCIAS:");
  warnings.forEach(item => console.log(`- ${item}`));
}
if (errors.length) {
  console.error("ERRORES:");
  errors.forEach(item => console.error(`- ${item}`));
  process.exit(1);
}
console.log(`OK: ${javascriptFiles.length} archivos JavaScript validados, ${htmlFiles.length} archivos HTML revisados, ${ids.length} IDs únicos y referencias locales verificadas.`);
