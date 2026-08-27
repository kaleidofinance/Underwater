import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The `wagmi/connectors` barrel (imported in app/providers.tsx for
  // coinbaseWallet/walletConnect) re-exports the Base Account connector, which
  // reaches @base-org/account → @coinbase/cdp-sdk → the optional @x402/* payment
  // packages. We never instantiate Base Account and those peers aren't installed,
  // so the production webpack build fails resolving them — while Turbopack dev,
  // which resolves lazily, tolerates it. Stub the dead subtree to false (an empty
  // module) so the barrel resolves. No trailing `$`, so subpaths like
  // `@x402/evm/upto/client` are matched too.
  webpack: (webpackConfig) => {
    webpackConfig.resolve.alias = {
      ...webpackConfig.resolve.alias,
      "@x402/evm": false,
      "@x402/core": false,
      "@x402/svm": false,
    };
    return webpackConfig;
  },
};

export default config;
