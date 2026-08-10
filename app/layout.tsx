import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const description = "Visite 360° interactive de la gare d’Arnex à partir de 45 panoramas géolocalisés.";

  return {
    metadataBase: baseUrl,
    title: "Arnex 360 — Visite immersive",
    description,
    openGraph: {
      title: "Arnex 360",
      description,
      type: "website",
      images: [{ url: new URL("/og.png", baseUrl).toString(), width: 1792, height: 936, alt: "Arnex 360 — visite immersive" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Arnex 360",
      description,
      images: [new URL("/og.png", baseUrl).toString()],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
