import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "محادثة فورية",
  description:
    "تطبيق محادثة فورية عربية بأسلوب واتساب — رسائل خاصة وغرفة عامة مباشرة مع مؤشرات الوصول والحضور.",
  applicationName: "محادثة فورية",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2300a884'%3E%3Cpath d='M12 2C6.48 2 2 6.02 2 11c0 2.87 1.49 5.43 3.82 7.1V22l3.6-1.98c.82.17 1.68.26 2.58.26 5.52 0 10-4.02 10-9S17.52 2 12 2z'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#008069",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl">
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
