// Copie htmx (dépendance npm) dans public/vendor pour le servir localement (pas de CDN, CSP stricte).
import { mkdirSync, copyFileSync } from 'node:fs';
mkdirSync('public/vendor', { recursive: true });
copyFileSync('node_modules/htmx.org/dist/htmx.min.js', 'public/vendor/htmx.min.js');
console.log('assets copiés');
