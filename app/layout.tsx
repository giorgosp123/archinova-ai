import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ArchiNova AI | 3D to Floor Plan",
  description:
    "Architectural AI built to reconstruct floor plans from multiple 3D building views using multi-view geometry analysis.",
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
