import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const baseUrl = new URL(`${protocol}://${host}`);
  const description = "Visionneuse 360° interactive pour explorer directement n’importe quel dossier de panoramas.";

  return {
    metadataBase: baseUrl,
    title: "Panorama 360 — Visionneuse immersive",
    description,
    openGraph: {
      title: "Panorama 360",
      description,
      type: "website",
      images: [{ url: new URL("/og.png", baseUrl).toString(), width: 1536, height: 1024, alt: "Panorama 360 — visionneuse immersive" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Panorama 360",
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
