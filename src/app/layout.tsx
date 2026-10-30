import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nutrition Coach",
  description: "An AI nutrition coach you text. Not a doctor.",
  robots: { index: false, follow: false },
};

// No third-party fonts, analytics or scripts (SPEC: no trackers). System font stack only.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
