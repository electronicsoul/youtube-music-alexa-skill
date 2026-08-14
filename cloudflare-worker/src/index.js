export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'alexa-audio-streamer' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Audio stream route: /stream/:videoId
    const streamMatch = url.pathname.match(/^\/stream\/([a-zA-Z0-9_-]+)/);
    if (!streamMatch) {
      return new Response('Not Found', { status: 404 });
    }

    const videoId = streamMatch[1];
    const resolverBase = env.RESOLVER_URL || 'https://youtube-music-alexa-skill.vercel.app/api/resolve-stream';

    try {
      // 1. Resolve direct GoogleVideo stream URL from Vercel resolver API
      const resolveRes = await fetch(`${resolverBase}?v=${videoId}`);
      if (!resolveRes.ok) {
        return new Response('Failed to resolve stream URL', { status: 502 });
      }
      const resolveData = await resolveRes.json();
      const directGoogleUrl = resolveData.streamUrl;

      if (!directGoogleUrl) {
        return new Response('Stream URL not found', { status: 404 });
      }

      // 2. Prepare headers for upstream fetch
      const forwardHeaders = new Headers({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-us,en;q=0.5',
        'Sec-Fetch-Mode': 'navigate'
      });

      const clientRange = request.headers.get('range');
      if (clientRange) {
        forwardHeaders.set('Range', clientRange);
      }

      // 3. Stream from Google CDN through Cloudflare Edge (no 30s timeout!)
      const googleRes = await fetch(directGoogleUrl, {
        method: 'GET',
        headers: forwardHeaders
      });

      // 4. Return streaming response to Alexa
      const responseHeaders = new Headers({
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache, no-store'
      });

      if (googleRes.headers.get('content-length')) {
        responseHeaders.set('Content-Length', googleRes.headers.get('content-length'));
      }
      if (googleRes.headers.get('content-range')) {
        responseHeaders.set('Content-Range', googleRes.headers.get('content-range'));
      }

      return new Response(googleRes.body, {
        status: googleRes.status,
        headers: responseHeaders
      });

    } catch (err) {
      return new Response('Streaming Proxy Error: ' + err.message, { status: 500 });
    }
  }
};
