import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Optimasi memory saat dev mode agar tidak terjadi memory leak (JavaScript heap out of memory)
  onDemandEntries: {
    maxInactiveAge: 30 * 1000, // bersihkan halaman tidak aktif setelah 30 detik
    pagesBufferLength: 2,      // batasi jumlah halaman aktif yang disimpan di RAM
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "framer-motion"],
  },
};

export default nextConfig;
