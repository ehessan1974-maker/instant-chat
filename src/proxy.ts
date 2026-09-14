import { NextRequest, NextResponse } from 'next/server'

/**
 * توجيه المتصفحات القديمة إلى النسخة الخفيفة (legacy.html)
 *
 * لماذا؟ واجهة التطبيق مبنية على Tailwind CSS 4 الذي يعتمد على ميزات CSS حديثة
 * (@layer, color-mix(), dvh...). المتصفحات القديمة (أندرويد 4/5 وWebView المجمد
 * وChrome < 99) تتجاهل كتل @layer بالكامل فتسقط كل التنسيقات وتظهر الصفحة
 * ككلمات متراكبة غير مفهومة. الحل: نكتشف المتصفح من User-Agent ونحوّل طلبه
 * إلى /legacy.html — نسخة ES5 بـCSS كلاسيكي تعمل على أي متصفح تقريباً.
 *
 * حدود الدعم الحديث:
 *   Chrome/Edge/WebView ≥ 99 (@layer)  — والعملي 111 لتجنب انكسار الألوان
 *   Firefox ≥ 113 (طبقات CSS)
 *   Safari ≥ 16.4 (طبقات CSS)
 *
 * ملاحظات:
 *   - صفحات API والملفات الثابتة تمرّ دائماً بلا توجيه.
 *   - يمكن فرض الواجهة الحديثة بـ?__modern=1 (يحفظ كوكيزاً للجلسة).
 */
export default function proxy(req: NextRequest) {
  const ua = req.headers.get('user-agent') ?? ''

  // مفتاح تجاوز يدوي: ?__modern=1 يضع كوكيزاً ويمنع التحويل نهائياً
  if (req.nextUrl.searchParams.has('__modern')) {
    const res = NextResponse.next()
    res.cookies.set('ic_modern', '1', { maxAge: 60 * 60 * 24 * 365, path: '/' })
    return res
  }
  if (req.cookies.get('ic_modern')?.value === '1') {
    return NextResponse.next()
  }

  if (!isLegacyUserAgent(ua)) {
    return NextResponse.next()
  }

  const url = req.nextUrl.clone()
  url.pathname = '/legacy.html'
  url.search = ''
  return NextResponse.redirect(url)
}

/** هل يبدو أن هذا المتصفح لا يدعم واجهة Tailwind 4؟ */
function isLegacyUserAgent(ua: string): boolean {
  // Chrome أو WebView القائم على Chromium: الإصدار هو المعيار
  const chrome = /Chrom(?:e|ium)\/(\d+)/.exec(ua)
  if (chrome) {
    return parseInt(chrome[1], 10) < 111
  }

  // أندرويد بمتصفح قديم بلا كروم (متصفح النظام المجمد) → قديم قطعاً
  if (/Android/.test(ua)) {
    return true
  }

  const firefox = /Firefox\/(\d+)/.exec(ua)
  if (firefox) {
    return parseInt(firefox[1], 10) < 113
  }

  // سفاري: Version/x.y قبل كلمة Safari
  const safari = /Version\/(\d+)[\d.]*\s.*Safari/.exec(ua)
  if (safari) {
    return parseInt(safari[1], 10) < 16
  }

  // متصفحات غير معروفة: نسمح بها (لن تصل عادةً)
  return false
}

export const config = {
  // كل المسارات عدا: API، أصول Next، الملفات الثابتة، والنسخة الخفيفة نفسها
  matcher: [
    '/((?!api|_next|legacy\\.html|favicon\\.ico|robots\\.txt|sitemap\\.xml|manifest|\\.well-known|relay-sms\\.sh|icon-\\d+|apple-icon|opengraph).*)',
  ],
}
