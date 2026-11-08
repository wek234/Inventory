// Copie les bibliothèques navigateur (dépendances npm) dans public/vendor : servies localement, sans CDN (CSP stricte).
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('public/vendor', { recursive: true });
copyFileSync('node_modules/htmx.org/dist/htmx.min.js', 'public/vendor/htmx.min.js');
copyFileSync('node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', 'public/vendor/simplewebauthn.min.js');
copyFileSync('node_modules/jsqr/dist/jsQR.js', 'public/vendor/jsqr.js');
console.log('assets copiés');
