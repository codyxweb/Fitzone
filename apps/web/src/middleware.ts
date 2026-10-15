import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const scriptSources = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "https://checkout.razorpay.com"];
  if (process.env.NODE_ENV !== "production") scriptSources.push("'unsafe-eval'");
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.razorpay.com ws: wss:",
    "frame-src https://*.razorpay.com",
    "frame-ancestors 'none'",
    "form-action 'self' https://*.razorpay.com",
    "base-uri 'self'",
    "object-src 'none'",
  ];
  if (process.env.NODE_ENV === "production") directives.push("upgrade-insecure-requests");
  const contentSecurityPolicy = directives.join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production") response.headers.set("Strict-Transport-Security", "max-age=31536000");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
