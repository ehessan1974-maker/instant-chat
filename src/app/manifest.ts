import type { MetadataRoute } from 'next';

/**
 * PWA manifest — يجعل التطبيق قابلاً للتثبيت من المتصفح
 * ويلزم لتحويله إلى APK عبر pwabuilder.com مجاناً.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'محادثة فورية',
    short_name: 'محادثة',
    description:
      'تطبيق محادثة فورية عربية — رسائل خاصة ومجموعات ورسائل صوتية ومكالمات صوت وفيديو.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    dir: 'rtl',
    lang: 'ar',
    background_color: '#efeae2',
    theme_color: '#008069',
    categories: ['social', 'communication'],
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
