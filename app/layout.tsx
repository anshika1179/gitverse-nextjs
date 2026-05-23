import "@/lib/env";
import { ReactNode } from "react";
import { Metadata } from "next";
import { Inter } from "next/font/google";
import { ThemeProvider } from "@/context/ThemeContext";
import { AuthProvider } from "@/contexts/AuthContext";
import { NextAuthProvider } from "@/components/auth/NextAuthProvider";
import { Toaster } from "@/components/ui/toaster";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GitVerse - AI-Powered Repository Analysis",
  description:
    "Contributions made easy with repo visualization and AI onboarding",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <ThemeProvider>
          <NextAuthProvider>
            <AuthProvider>
              {children}
              <Toaster />
            </AuthProvider>
          </NextAuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}