import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  /**
   * The app lives at /app (market), /create, /account and /token/<id>. These
   * send the paths people naturally guess, and links from before the move,
   * to the right page instead of a 404.
   */
  async redirects() {
    return [
      { source: "/app/create", destination: "/create", permanent: false },
      { source: "/app/account", destination: "/account", permanent: false },
      { source: "/app/token/:id", destination: "/token/:id", permanent: false },
      { source: "/launch", destination: "/create", permanent: false },
      { source: "/zec", destination: "/app", permanent: false },
      { source: "/zec/create", destination: "/create", permanent: false },
      { source: "/zec/account", destination: "/account", permanent: false },
      { source: "/zec/token/:id", destination: "/token/:id", permanent: false },
    ];
  },
};

export default config;
