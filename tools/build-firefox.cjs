// build-firefox.cjs - сборка под Firefox (ПК и Android): копия src/ в dist/firefox/ со своим манифестом.
// Только встроенные модули Node. Запуск: node tools/build-firefox.cjs
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const outDir = path.join(root, 'dist', 'firefox');

// В Firefox нет offscreen-документа: движок загрузки (engine.html) и background.js живут в одной фоновой странице
function firefoxManifest(chromeManifest) {
  const { background, ...manifest } = chromeManifest; // service_worker Firefox не нужен
  return {
    ...manifest,
    permissions: chromeManifest.permissions.filter(permission => permission !== 'offscreen' && permission !== 'system.display'),
    background: { page: 'engine/background-firefox.html' },
    browser_specific_settings: {
      gecko: { id: 'libsaver@laynholt', strict_min_version: '128.0' },
      gecko_android: { strict_min_version: '128.0' }
    }
  };
}

function build() {
  fs.rmSync(outDir, { recursive: true, force: true });
  // _metadata - кэш правил, который создаёт Chrome; Firefox он не нужен
  fs.cpSync(srcDir, outDir, { recursive: true, filter: file => path.basename(file) !== '_metadata' });
  const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(firefoxManifest(manifest), null, 2) + '\n');
  console.log(`Firefox: ${path.relative(root, outDir)}`);
}

if (require.main === module) build();

module.exports = { firefoxManifest };
