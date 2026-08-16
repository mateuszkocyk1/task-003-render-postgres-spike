import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const forbiddenModelNames = ["User", "Company", "Job", "Payment", "Match", "Service", "Market"];
const secretPatterns = [
  /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i,
  /RENDER_API_KEY\s*=\s*\S+/i,
  /DATABASE_URL\s*=\s*postgres/i,
];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if ([".git", "node_modules", "generated"].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

const sourceFiles = await files(root);
for (const file of sourceFiles) {
  const content = await readFile(file, "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) throw new Error(`Potential secret in ${file}`);
  }
  if (file.endsWith("schema.prisma")) {
    for (const model of forbiddenModelNames) {
      if (new RegExp(`\\bmodel\\s+${model}\\b`).test(content)) {
        throw new Error(`Forbidden product model ${model} in ${file}`);
      }
    }
  }
}
console.log(`SOURCE_CHECK_PASS files=${sourceFiles.length}`);
