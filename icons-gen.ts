// توليد أيقونات PWA (192 و512) — فقاعة دردشة بيضاء على خلفية خضراء واتساب
// تشغيل لمرة واحدة: bun icons-gen.ts
import sharp from 'sharp';
import path from 'path';

const svg = (size: number) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${Math.round(size * 0.185)}" fill="#00a884"/>
  <g transform="translate(256,256)">
    <path d="M 0 -130 C -98 -130 -178 -64 -178 18 C -178 62 -154 101 -116 128 L -128 186 L -58 152 C -40 156 -20 158 0 158 C 98 158 178 96 178 18 C 178 -64 98 -130 0 -130 Z"
      fill="#ffffff"/>
    <circle cx="-64" cy="20" r="18" fill="#00a884"/>
    <circle cx="0" cy="20" r="18" fill="#00a884"/>
    <circle cx="64" cy="20" r="18" fill="#00a884"/>
  </g>
</svg>`;

async function gen(size: number) {
  const out = path.resolve(process.cwd(), `public/icon-${size}.png`);
  await sharp(Buffer.from(svg(size))).resize(size, size).png().toFile(out);
  console.log(`✓ public/icon-${size}.png`);
}

await gen(192);
await gen(512);
console.log('تم توليد الأيقونات');
