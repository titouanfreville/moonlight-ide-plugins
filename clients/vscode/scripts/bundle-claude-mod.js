/**
 * Copy the MoonlightCode mod for Claude Code into an extension, as a local
 * marketplace: `claude-mod/.claude-plugin/marketplace.json` plus the plugin in
 * `claude-mod/moonlightcode/`.
 *
 * Run from an extension directory: `node ../../scripts/bundle-claude-mod.js`.
 *
 * Why it ships with the extension: on a fresh install with no daemon and no
 * network to reach the repository's marketplace, this copy is what the editor
 * installs into Claude Code so sessions are still gated (see
 * moonlight-core/src/claude-mod.ts). Tests and test helpers stay behind.
 */
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const source = path.resolve(__dirname, '..', '..', 'claude-code', 'moonlight');
const out = path.join(cwd, 'claude-mod');
const plugin = path.join(out, 'moonlightcode');

const SHIPPED = ['.claude-plugin', 'hooks', 'types', 'README.md'];
// Tests and their kit stay behind, and so do the editor types `/plugin-types` writes.
const isLeftBehind = (from) =>
  /\.test\.tsx?$/.test(from) || path.basename(from) === 'gate-kit.ts' ||
  from.includes(`${path.sep}.claude-plugin${path.sep}types`);

fs.rmSync(out, { recursive: true, force: true });
for (const entry of SHIPPED) {
  fs.cpSync(path.join(source, entry), path.join(plugin, entry), {
    recursive: true,
    filter: (from) => !isLeftBehind(from),
  });
}

const { version, description } = JSON.parse(fs.readFileSync(path.join(source, '.claude-plugin', 'plugin.json'), 'utf8'));
fs.mkdirSync(path.join(out, '.claude-plugin'), { recursive: true });
fs.writeFileSync(
  path.join(out, '.claude-plugin', 'marketplace.json'),
  `${JSON.stringify(
    {
      // The repository's marketplace name: either copy installs `moonlightcode@moonlight`.
      name: 'moonlight',
      owner: { name: 'Titouan Freville' },
      plugins: [{ name: 'moonlightcode', source: './moonlightcode', version, description }],
    },
    null,
    2
  )}\n`
);
console.log(`bundled the Claude Code mod ${version} -> claude-mod/`);
