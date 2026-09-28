/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Serve the static console + blueprint (public/*.html) at clean paths.
    return [
      { source: '/', destination: '/index.html' },
      { source: '/subaccount/:slug', destination: '/index.html' },
      { source: '/blueprint', destination: '/blueprint.html' },
      { source: '/accept-invite', destination: '/accept-invite.html' },
    ]
  },
  async headers() {
    const noStore = { key: 'Cache-Control', value: 'no-store, must-revalidate' }
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      // Always revalidate the app shell so every browser (including an agent's)
      // loads the current code + fetches live data, never a stale cached page.
      { source: '/', headers: [noStore] },
      { source: '/index.html', headers: [noStore] },
      { source: '/subaccount/:slug', headers: [noStore] },
      { source: '/blueprint', headers: [noStore] },
      { source: '/blueprint.html', headers: [noStore] },
      { source: '/accept-invite', headers: [noStore] },
      { source: '/accept-invite.html', headers: [noStore] },
    ]
  },
}

export default nextConfig
