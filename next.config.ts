import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async headers() {
    return [
      // منع أي طبقة وسيطة (بوابة/كاش) من تقديم نسخة قديمة من الصفحة والـ manifest وواجهات API
      // (ملفات /_next/static تبقى قابلة للكاش — أسماؤها موقّعة hash فلا خطر منها)
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "no-store, must-revalidate" },
        ],
      },
      {
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
