// [xihanzu-NR]
'use strict';

/**
 * Build the .vsix without `vsce`.
 *
 * `vsce` is a dependency tree and a token, and a .vsix is a zip with two XML
 * descriptors in it. Packaging by hand keeps the promise the extension makes
 * elsewhere — nothing is installed to build it — and it runs in CI without a
 * marketplace account.
 *
 *   node scripts/package-vsix.mjs [--out dir]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.resolve(HERE, '..', '..');

const PAYLOAD = [
  'package.json',
  'extension.js',
  'src',
  'snippets',
  'syntaxes',
  'language-configuration.json',
  'schema.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'icon.png',
];

function fail(message) {
  process.stderr.write(`package-vsix: ${message}\n`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));

function copy(target, source) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source)) copy(path.join(target, entry), path.join(source, entry));
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

/**
 * `hydraconfig.json` validation uses the schema the compiler ships. Copying it
 * at package time is what keeps the editor's idea of a valid config and the
 * compiler's from drifting: there is one file, and this is a copy of it.
 */
function syncSchema() {
  const source = path.join(REPO, 'schema.json');
  if (!fs.existsSync(source)) fail(`no schema.json at ${source}`);
  fs.copyFileSync(source, path.join(HERE, 'schema.json'));
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".mjs" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".xml" ContentType="text/xml" />
  <Override PartName="/extension.vsixmanifest" ContentType="text/xml" />
</Types>
`;

const VSIX_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${manifest.name}" Version="${manifest.version}" Publisher="${manifest.publisher}" />
    <DisplayName>${manifest.displayName}</DisplayName>
    <Description xml:space="preserve">${manifest.description}</Description>
    <Tags>${manifest.keywords.join(',')}</Tags>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${manifest.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Readme" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Code.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;

function main() {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex === -1 ? path.join(REPO, 'dist') : path.resolve(process.argv[outIndex + 1]);

  syncSchema();

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-vsix-'));
  fs.writeFileSync(path.join(staging, '[Content_Types].xml'), CONTENT_TYPES);
  fs.writeFileSync(path.join(staging, 'extension.vsixmanifest'), VSIX_MANIFEST);

  for (const entry of PAYLOAD) {
    const source = path.join(HERE, entry);
    if (!fs.existsSync(source)) fail(`missing ${entry} — run the tests before packaging`);
    copy(path.join(staging, 'extension', entry), source);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `${manifest.name}-${manifest.version}.vsix`);
  fs.rmSync(target, { force: true });

  try {
    execFileSync('zip', ['-q', '-r', '-X', target, '.'], { cwd: staging, stdio: 'pipe' });
  } catch (err) {
    fail(`zip is required to build a .vsix (${err.message})`);
  }

  const bytes = fs.statSync(target).size;
  fs.rmSync(staging, { recursive: true, force: true });
  process.stdout.write(`${target} (${(bytes / 1024).toFixed(1)} KiB)\n`);
}

main();
