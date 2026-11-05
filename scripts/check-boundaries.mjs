import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const packages = ['packages/shared', 'packages/agent', 'apps/server', 'apps/web'];
const allowed = {
  '@lingma/shared': [],
  '@lingma/agent': ['@lingma/shared'],
  '@lingma/server': ['@lingma/shared', '@lingma/agent'],
  '@lingma/web': ['@lingma/shared'],
};
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
let failures = 0;
function fail(path, message) {
  console.error(`${relative(root, path)}: ${message}`);
  failures++;
}
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (/\.[cm]?[jt]sx?$/.test(path)) result.push(path);
  }
  return result;
}
for (const directory of packages) {
  const packageRoot = resolve(root, directory);
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (
      name.startsWith('@lingma/') &&
      (!allowed[manifest.name].includes(name) || version !== 'workspace:*')
    )
      fail(packageRoot, `invalid workspace dependency ${name}`);
    if (manifest.name === '@lingma/shared' && name !== 'zod')
      fail(packageRoot, `shared dependency must be pure: ${name}`);
    if (
      manifest.name === '@lingma/agent' &&
      !['@lingma/shared', '@earendil-works/pi-ai'].includes(name)
    )
      fail(packageRoot, `agent dependency forbidden: ${name}`);
  }
  for (const path of await files(resolve(packageRoot, 'src'))) {
    const source = ts.createSourceFile(
      path,
      await readFile(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      let specifier;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        specifier = node.moduleSpecifier.text;
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        specifier = node.arguments[0].text;
      if (specifier) {
        if (
          specifier.startsWith('.') &&
          !resolve(dirname(path), specifier).startsWith(`${packageRoot}/`)
        )
          fail(path, 'relative import escapes package');
        if (
          specifier.startsWith('@lingma/') &&
          !allowed[manifest.name].some((name) => specifier === name)
        )
          fail(path, `forbidden import ${specifier}`);
        if (
          ['@lingma/shared', '@lingma/web'].includes(manifest.name) &&
          (specifier.startsWith('node:') || builtins.has(specifier))
        )
          fail(path, 'Node import in browser boundary');
        if (specifier.includes('pi-ai') && !relative(packageRoot, path).startsWith('src/model/'))
          fail(path, 'pi-ai import outside model adapter');
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
if (failures) process.exitCode = 1;
else console.log('Workspace boundaries verified.');
