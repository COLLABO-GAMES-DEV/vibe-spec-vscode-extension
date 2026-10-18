import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function checkRelease(tag, manifest) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Release tag must be vMAJOR.MINOR.PATCH (stable versions only).');
  }
  if (tag !== `v${manifest.version}`) {
    throw new Error(`Tag ${tag} does not match packages/vscode/package.json version ${manifest.version}.`);
  }
  if (manifest.publisher !== 'ijun17' || manifest.name !== 'vibe-spec' || manifest.license !== 'UNLICENSED') {
    throw new Error('Expected ijun17.vibe-spec with license UNLICENSED.');
  }
  return { tag, version: manifest.version, vsix: `artifacts/vibe-spec-${manifest.version}.vsix` };
}

export function checkUnpublished(manifest, published) {
  // A failed/changed gallery response must not be mistaken for an unused version.
  if (published?.publisher?.publisherName !== manifest.publisher
      || published.extensionName !== manifest.name || !Array.isArray(published.versions)
      || published.versions.length === 0
      || published.versions.some(entry => typeof entry.version !== 'string')) {
    throw new Error('Cannot verify Marketplace versions for ijun17.vibe-spec.');
  }
  if (published.versions.some(entry => entry.version === manifest.version)) {
    throw new Error(`Marketplace version ${manifest.version} already exists. Bump the version; do not overwrite it.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../packages/vscode/package.json', import.meta.url), 'utf8'));
    const [command, argument] = process.argv.slice(2);
    if (command === 'check') {
      const result = checkRelease(argument, manifest);
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
      }
      console.log(JSON.stringify(result));
    } else if (command === 'unpublished' && argument) {
      checkUnpublished(manifest, JSON.parse(readFileSync(argument, 'utf8')));
      console.log(`Marketplace version ${manifest.version} is not published.`);
    } else {
      throw new Error('Usage: node scripts/release.mjs check vX.Y.Z | unpublished metadata.json');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
