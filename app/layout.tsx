import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ArchiNova AI | From plan to vision",
  description:
    "AI architectural visualization for architects and designers. Upload a plan, describe your vision and create presentation-ready concepts.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
