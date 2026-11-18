// Write next-env.d.ts when it is missing. The file is in .gitignore, and only `next dev` or
// `next build` writes it. Without it, a clean checkout has no type for image and *.svg imports,
// and tsc fails.
import fs from 'node:fs';

if (!fs.existsSync('next-env.d.ts')) {
  fs.writeFileSync('next-env.d.ts', '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
}
